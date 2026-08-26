/**
 * A wedged mail host must not stop the activity feed from pruning.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MERGE PLAN MAKES WAVE M2 CONDITIONAL ON EXACTLY THIS, AND THEN PRESCRIBES THE SHAPE THAT
 * BREAKS IT.**
 *
 * The plan's own words: the wave is safe only if "the SMTP delivery worker keeps its own job lease
 * so a wedged mail host cannot stall the activity record". Its mechanics step 4, four sections
 * later, says "jobs and topic subscriptions are unioned" — and unioning the RUNNERS is precisely
 * the arrangement the first sentence forbids.
 *
 * Three measured facts, all still true in this repository, are what make it a real hazard rather
 * than a theoretical one:
 *
 *   1. `notify/jobs.ts` registers `notify.dispatch` with a handler that drains in a `for(;;)` loop
 *      — it returns only when a pass claims nothing — so one claim can occupy a slot indefinitely.
 *   2. `notify/pipeline.ts`'s `dispatchDue` sends SERIALLY: `for (const delivery of claimed) { …
 *      await adapter.send(message) … }`. One slow recipient blocks every other delivery in the pass.
 *   3. `notify/email.ts`'s `openSmtp` passes host, port, secure and auth to nodemailer and sets NO
 *      `connectionTimeout`, `greetingTimeout` or `socketTimeout`. An unreachable mail host is
 *      therefore bounded by the operating system's TCP timeout, which is minutes.
 *
 * A single runner at activity's `concurrency: 2` would hold those three against
 * `activity.inbox.prune` and `activity.records.prune`. The feed's retention would stop running
 * because a mail server was down — and `activity_retention_overdue_total`, the gauge written to be
 * the alarm for exactly that, would be the only thing that ever said so.
 *
 * So: two runners, two budgets. This file proves what that buys, and the second case proves the
 * counterfactual is real rather than assumed — a test that only showed the good arrangement working
 * would pass just as happily against the bad one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Real Postgres on both sides, because the thing under test is a LEASE — `claim` is a
 * `for update skip locked` against a table, and a fake queue would be a test of the fake.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { INBOX_PRUNE_KIND } from './jobs.ts'
import {
  migrateTestDb,
  openDb,
  resetActivity,
  skip as activitySkip,
  enabled as activityEnabled,
} from './testsupport.ts'
import {
  migrateTestDb as migrateNotifyDb,
  openDb as openNotifyDb,
  resetNotify,
  enabled as notifyEnabled,
} from './notify/testsupport.ts'
import { DISPATCH_KIND, NOTIFY_JOB_CONCURRENCY } from './notify/jobs.ts'

/** activity's budget, as `index.ts` sets it. The number the shared-runner case would inherit. */
const ACTIVITY_JOB_CONCURRENCY = 2

const skip =
  activityEnabled && notifyEnabled ? false : activitySkip || 'set NOTIFY_TEST_DATABASE_URL'

/**
 * A handler that never returns, and the switch that releases it.
 *
 * This is the wedged mail host, modelled at the only place its shape matters: a claimed job whose
 * handler does not settle. Nothing here opens a socket — `openSmtp`'s missing timeouts are quoted
 * in the header rather than exercised, because a test that waited for a real TCP timeout would take
 * minutes and would be testing the kernel's network stack.
 */
function wedge(): { handler: () => Promise<void>; release: () => void; entered: () => number } {
  const waiting: Array<() => void> = []
  let count = 0
  return {
    handler: () =>
      new Promise<void>((resolve) => {
        count += 1
        waiting.push(resolve)
      }),
    release: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
    entered: () => count,
  }
}

/** Wait until `predicate` holds, or give up. Bounded so a broken runner fails rather than hangs. */
async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('a saturated notify runner does not starve the activity queue', { skip }, () => {
  let activitySql: postgres.Sql
  let notifySql: postgres.Sql

  before(async () => {
    activitySql = openDb()
    await migrateTestDb(activitySql)
    notifySql = openNotifyDb()
    await migrateNotifyDb(notifySql)
  })

  after(async () => {
    await activitySql.end({ timeout: 5 }).catch(() => {})
    await notifySql.end({ timeout: 5 }).catch(() => {})
  })

  it('claims an activity job while every notify slot is held by a wedged dispatch', async () => {
    await resetActivity(activitySql)
    await resetNotify(notifySql)

    const notifyQueue = new JobQueue(notifySql as unknown as JobsSql, { owner: 'starvation-notify' })
    const activityQueue = new JobQueue(activitySql as unknown as JobsSql, { owner: 'starvation-activity' })

    const wedged = wedge()
    const notifyRunner = new JobRunner({
      queue: notifyQueue,
      concurrency: NOTIFY_JOB_CONCURRENCY,
      pollMs: 10,
    })
    notifyRunner.register(DISPATCH_KIND, wedged.handler)

    let activityRan = 0
    const activityRunner = new JobRunner({
      queue: activityQueue,
      concurrency: ACTIVITY_JOB_CONCURRENCY,
      pollMs: 10,
    })
    activityRunner.register(INBOX_PRUNE_KIND, async () => {
      activityRan += 1
    })

    try {
      // Fill notify's budget and then some, so "saturated" is a fact rather than a hope.
      for (let i = 0; i < NOTIFY_JOB_CONCURRENCY + 3; i += 1) {
        await notifyQueue.enqueue({ kind: DISPATCH_KIND, key: `wedged-${i}` })
      }
      notifyRunner.start()
      await until(
        () => notifyRunner.inFlight === NOTIFY_JOB_CONCURRENCY,
        'the notify runner to saturate',
      )

      // Every slot is held and there is still work queued behind it: this is the state a mail host
      // with no socket timeout puts the dispatcher in.
      assert.equal(notifyRunner.inFlight, NOTIFY_JOB_CONCURRENCY)
      assert.equal(wedged.entered(), NOTIFY_JOB_CONCURRENCY, 'nothing beyond the budget was claimed')
      assert.ok((await notifyQueue.stats()).pending >= 3, 'and a backlog is waiting on those slots')

      // NOW the activity side. It has its own queue and its own budget, so its runner is unaffected
      // by every one of the four facts above.
      await activityQueue.enqueue({ kind: INBOX_PRUNE_KIND, key: 'global' })
      assert.equal(await activityRunner.tick(), 1, 'the activity job must be CLAIMED, not queued')
      assert.equal(activityRan, 1, 'and it must have run to completion')

      // The wedge is still wedged. If the notify handlers had quietly settled, the case above would
      // have proved nothing at all.
      assert.equal(notifyRunner.inFlight, NOTIFY_JOB_CONCURRENCY, 'the mail host is still wedged')
    } finally {
      wedged.release()
      await notifyRunner.stop(2_000)
      await activityRunner.stop(2_000)
    }
  })

  it('and the same work IS starved when one runner carries both — the shape the plan prescribes', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════════════════════════
     * THE COUNTERFACTUAL, RUN RATHER THAN ARGUED.
     *
     * "Jobs and topic subscriptions are unioned" reads as bookkeeping. This is what it costs: ONE
     * runner, activity's budget, both kinds registered — the arrangement a merge does by default if
     * nobody thinks about it — and `activity.inbox.prune` is never claimed at all while the mail
     * host is down.
     *
     * Both kinds are enqueued on ONE queue here. In the real process they could not be, because
     * they are tables in two different databases; that is a second, independent reason the runners
     * cannot be unioned, and it is why the budget is the interesting half. The point of running it
     * on one queue is to isolate the BUDGET as the cause: same table, same lease, same claim query,
     * and the activity job still never runs.
     * ════════════════════════════════════════════════════════════════════════════════════════════
     */
    await resetActivity(activitySql)

    const shared = new JobQueue(activitySql as unknown as JobsSql, { owner: 'starvation-shared' })
    const wedged = wedge()
    let activityRan = 0

    const oneRunner = new JobRunner({
      queue: shared,
      // The union: ONE budget for both modules, and it is the smaller of the two.
      concurrency: ACTIVITY_JOB_CONCURRENCY,
      pollMs: 10,
    })
    oneRunner.register(DISPATCH_KIND, wedged.handler)
    oneRunner.register(INBOX_PRUNE_KIND, async () => {
      activityRan += 1
    })

    try {
      for (let i = 0; i < ACTIVITY_JOB_CONCURRENCY; i += 1) {
        await shared.enqueue({ kind: DISPATCH_KIND, key: `wedged-${i}` })
      }
      oneRunner.start()
      await until(() => oneRunner.inFlight === ACTIVITY_JOB_CONCURRENCY, 'the shared runner to saturate')

      // Enqueued AFTER the wedge, which is the ordinary case: the mail host went down first.
      await shared.enqueue({ kind: INBOX_PRUNE_KIND, key: 'global' })

      // Give it many poll intervals. This is not a race that resolves later — there is no capacity
      // and there will not be one until a mail host that is not answering answers.
      await new Promise((resolve) => setTimeout(resolve, 200))

      assert.equal(activityRan, 0, 'the activity job never runs — this is the starvation')
      const pending = (await shared.stats()).pending
      assert.ok(pending >= 1, `the prune is still queued behind the mail host (pending=${pending})`)

      // And it is the BUDGET, not the queue: release the wedge and the very same job is claimed.
      wedged.release()
      await until(() => oneRunner.inFlight === 0, 'the wedge to clear')
      await oneRunner.tick()
      assert.equal(activityRan, 1, 'once a slot frees, the identical job runs — so capacity was the cause')
    } finally {
      wedged.release()
      await oneRunner.stop(2_000)
    }
  })

  it('the two modules’ job kinds do not collide, which is the OTHER thing a union would have hidden', () => {
    // Confirmed rather than assumed, because it is the reason this wave's metric collision is the
    // unlabelled `jobs_pending` pair and not — as in wave M1 — `jobs_failed_total{kind="rollup"}`
    // summing two unrelated queues.
    assert.match(INBOX_PRUNE_KIND, /^activity\./)
    assert.match(DISPATCH_KIND, /^notify\./)
    assert.notEqual(INBOX_PRUNE_KIND, DISPATCH_KIND)
  })
})
