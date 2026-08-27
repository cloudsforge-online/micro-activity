/**
 * The merged surface: both modules, one listener, driven over a real socket against BOTH databases.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE ONLY TEST THAT SEES WHAT THE PROCESS ACTUALLY IS.**
 *
 * `server.test.ts` drives activity alone and `notify/server.test.ts` drives notify alone, and both
 * still pass unchanged — which is the point of the module seam, and also the reason neither can see
 * any of the five things a merge can break:
 *
 *   1. **A route reading the wrong module's database.** The kernel resolves ONE handle per request
 *      from ONE selector. Mounted without `RouteSpec.sql`, notify's handlers would be handed
 *      activity's pool — and both modules own a table called `inbox` WITH IDENTICAL COLUMNS, so
 *      that is not a 500. It is an insert into the other module's dedupe table that succeeds and
 *      makes the next genuine delivery of that event a "duplicate". Neither single-module suite
 *      can see it, because in each of them there is only one database.
 *   2. **Two `/livez`, `/readyz`, `/metrics`.** Matching is first-wins, so the second copy of each
 *      is simply dead — and a dead health endpoint looks exactly like a live one.
 *   3. **A `/readyz` that reports half the process.** activity's Lifecycle probing only activity's
 *      database answers 200 while every notification in the estate is failing.
 *   4. **Job metrics that erase each other.** `jobs_pending` and `jobs_overdue` carry no `kind`, so
 *      before the `module` label each module's sample OVERWROTE the other's and a wedged queue was
 *      ABSENT from the graph rather than high.
 *   5. **One `/ingest` with two secret sets.** The collision this wave exists to resolve. Each
 *      module now has an inbox of its own, verified by its own secret and no other, and the path
 *      they shared answers 410 naming both.
 *
 * Two databases are required, and the suite skips without both. It is the one file in this
 * repository that needs `ACTIVITY_TEST_DATABASE_URL` and `NOTIFY_TEST_DATABASE_URL` at once, and
 * `service-ci.yml` provides exactly that — one CI database per declared variable, for the reason
 * `migratortargets.test.ts` measures: both modules own a table called `inbox` and a table called
 * `jobs`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs'
import { SIGNATURE_HEADER, signDelivery } from '@cloudsforge/contracts-events'
import { TokenError, type Principal } from '@cloudsforge/auth'
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle'
import { Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import {
  ACTIVITY_INGEST_PATH,
  INGEST_PATHS,
  createMergedServer,
  registerServiceMetrics,
} from './server.ts'
import {
  ALICE,
  BOB,
  SECRET,
  delivery,
  ingestDeps,
  migrateTestDb,
  openDb,
  quietLogger,
  resetActivity,
  skip as activitySkip,
  enabled as activityEnabled,
} from './testsupport.ts'
import {
  migrateTestDb as migrateNotifyDb,
  openDb as openNotifyDb,
  registeredEvent,
  resetNotify,
  enabled as notifyEnabled,
} from './notify/testsupport.ts'

/*
 * ── THE NOTIFY MODULE VALIDATES ITS CONFIGURATION AT IMPORT AND EXITS ON A BAD ONE ─────────────
 *
 * Right for a service, fatal for a test runner — `notify/env.test.ts` records the same problem and
 * solves it the same way. So a complete environment is populated FIRST and the module is then
 * imported dynamically.
 *
 * The secret is generated per run rather than written as a literal, for the reason
 * `@cloudsforge/secrets` exists: a hyphenated placeholder that clears a length check is the exact
 * family of value the estate actually shipped, and no repository should hold a string that looks
 * like a signing key.
 *
 * The DSN is this suite's own test database, so the module's notify half reads the same database
 * `resetNotify` truncates.
 */
const NOTIFY_TEST_DSN_VAR = 'NOTIFY_TEST_DATABASE_URL'
const NOTIFY_INGEST_SECRET = randomBytes(48).toString('base64')
process.env['NOTIFY_DATABASE_URL'] =
  process.env[NOTIFY_TEST_DSN_VAR] ?? ['postgres://u:p@127.0.0.1:5432', 'unset_test'].join('/')
process.env['NOTIFY_INGEST_SIGNING_SECRET'] ??= NOTIFY_INGEST_SECRET
process.env['NOTIFY_PUBLIC_URL'] ??= 'https://app.cloudsforge.test'
process.env['IDENTITY_JWKS_URL'] ??= 'http://127.0.0.1:4001/.well-known/jwks.json'
process.env['IDENTITY_ISSUER'] ??= 'http://127.0.0.1:4001'
const { createNotifyModule } = await import('./notify/module.ts')
const { NOTIFY_INGEST_PATH } = await import('./notify/server.ts')

/** What the module actually loaded, which is what a signature in this suite has to match. */
const LIVE_NOTIFY_SECRET = process.env['NOTIFY_INGEST_SIGNING_SECRET'] ?? ''

/** Accepts one bearer as an operator; everything else is a 401. */
const verifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'good-operator') return { kind: 'user', userId: ALICE, handle: 'op', roles: ['admin'] }
    throw new TokenError('bad token', 'invalid')
  },
}

const skip = activityEnabled && notifyEnabled ? false : activitySkip || `set ${NOTIFY_TEST_DSN_VAR}`

describe('the merged surface', { skip }, () => {
  let activitySql: postgres.Sql
  let notifySql: postgres.Sql
  let notify: Awaited<ReturnType<typeof createNotifyModule>>
  let server: Server
  let url: string
  let registry: Metrics
  let stopped = false

  before(async () => {
    activitySql = openDb()
    await migrateTestDb(activitySql)
    await resetActivity(activitySql)

    notifySql = openNotifyDb()
    await migrateNotifyDb(notifySql)
    await resetNotify(notifySql)

    // Exactly the arrangement `index.ts` builds: ONE registry rendered by /metrics, a labelled view
    // per module for the JOB plane only, one Lifecycle with two hard probes, both route tables on
    // one listener.
    registry = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
    const jobMetrics = registry.withLabels({ module: 'activity' })

    // `cacheMs: 0` because a case below asserts what /readyz says a moment AFTER a database goes
    // away, and the default one-second cache would answer with the report from before it did.
    const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100, cacheMs: 0 })
    lifecycle.markReady()

    notify = await createNotifyModule({
      metrics: registry,
      verifier,
      claimingJobs: () => false,
      track: () => lifecycle.track(),
    })

    lifecycle.addProbe(postgresProbe('postgres-activity', () => activitySql`select 1`))
    lifecycle.addProbe(notify.probe)

    const queue = new JobQueue(activitySql as unknown as JobsSql, { owner: 'merged-test' })
    server = createMergedServer(
      {
        lifecycle,
        logger: quietLogger(),
        // The REGISTRY, not a view: /metrics renders this object, and the kernel's HTTP metrics are
        // process-wide — one listener serves both modules and `route` already says which.
        metrics: registry,
        verifier,
        sql: networkSql({ mainnet: activitySql as unknown as RuntimeSql }),
        singleNetwork: 'mainnet' as const,
        ingest: ingestDeps(activitySql as never),
        beforeScrape: async () => {
          const stats = await queue.stats()
          jobMetrics.set('jobs_pending', stats.pending)
          jobMetrics.set('jobs_overdue', stats.overdue)
          registry.set('activity_unclassified_total', 0)
          await notify.beforeScrape()
        },
      },
      notify.routes,
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (!stopped) await notify.stop()
    await activitySql.end({ timeout: 5 }).catch(() => {})
    await notifySql.end({ timeout: 5 }).catch(() => {})
  })

  /* ---------------------------------------------------------------- route table */

  describe('the two route tables are mounted, and neither shadows the other', () => {
    it("answers activity's reads", async () => {
      const res = await fetch(`${url}/feed`, { headers: { authorization: 'Bearer good-operator' } })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { records: unknown[] }
      assert.ok(Array.isArray(body.records))
    })

    it("answers notify's reads on the SAME listener and the SAME port", async () => {
      // `deliveries` is notify's. activity's database has no such table, so a route handed the
      // host's selector would 500 here rather than answer — and this route reads through
      // `deps.store`, which is the OTHER way the wrong pool would arrive.
      const res = await fetch(`${url}/admin/deliveries`, {
        headers: { authorization: 'Bearer good-operator' },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { deliveries: unknown[] }
      assert.ok(Array.isArray(body.deliveries))
    })

    it("notify's preferences route answers, which activity has no table for at all", async () => {
      const res = await fetch(`${url}/preferences`, { headers: { authorization: 'Bearer good-operator' } })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { categories: string[] }
      assert.ok(body.categories.length > 0, 'this is notify data served through activity’s listener')
    })
  })

  /* ---------------------------------------------------------------- the ingest split */

  describe('two inboxes, two secrets, and no path from one secret to the other sink', () => {
    /**
     * The wave's central claim, driven end to end.
     *
     * Each module's inbox accepts ONLY its own secret. That is the property one shared mount could
     * not have had: with both secret sets on one path, the key that mints a person's security email
     * would also write the canonical record of what happened to their money.
     */
    it('accepts an activity-signed event at /ingest/activity and refuses a notify-signed one', async () => {
      const event = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-m1', payload: { userId: ALICE } })
      const accepted = await fetch(`${url}${ACTIVITY_INGEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: event.signature },
        body: event.body,
      })
      assert.equal(accepted.status, 201)

      // The SAME bytes, signed with notify's secret. activity must not accept it.
      const crossSigned = signDelivery(event.body, LIVE_NOTIFY_SECRET)
      const refused = await fetch(`${url}${ACTIVITY_INGEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: crossSigned },
        body: event.body,
      })
      assert.equal(refused.status, 401, "notify's secret must not open activity's inbox")
      assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'bad_signature')
    })

    it('accepts a notify-signed event at /ingest/notify and refuses an activity-signed one', async () => {
      const event = notifyEvent()
      const accepted = await fetch(`${url}${NOTIFY_INGEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signDelivery(event, LIVE_NOTIFY_SECRET) },
        body: event,
      })
      assert.equal(accepted.status, 202)

      const refused = await fetch(`${url}${NOTIFY_INGEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signDelivery(event, SECRET) },
        body: event,
      })
      assert.equal(refused.status, 401, "activity's secret must not open notify's inbox")
      assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'bad_signature')
    })

    it('answers the retired shared /ingest with 410 naming both, whatever it is signed with', async () => {
      const event = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-m2', payload: { userId: ALICE } })
      for (const signature of [event.signature, signDelivery(event.body, LIVE_NOTIFY_SECRET), 'nonsense']) {
        const res = await fetch(`${url}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
          body: event.body,
        })
        assert.equal(res.status, 410)
        const body = (await res.json()) as { error: { code: string; served: string[] } }
        assert.equal(body.error.code, 'ingest_path_split')
        assert.deepEqual(body.error.served, [...INGEST_PATHS])
      }
    })

    /**
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * BOTH MODULES OWN A TABLE CALLED `inbox`, WITH IDENTICAL COLUMNS.
     *
     * This is the case wave M1's equivalent could not have: analytics' `events` and lantern's
     * `events` had different columns, so the wrong handle was a 500. Here the wrong handle is an
     * insert that SUCCEEDS in the other module's dedupe table — after which the event is a
     * "duplicate" the first time it genuinely arrives, and nothing anywhere says so.
     *
     * So the assertion is about WHICH DATABASE each row landed in, read directly, rather than
     * about what either route answered.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    it('lands each module’s inbox row in its OWN database and not in the other', async () => {
      const activityRows = await activitySql<{ topic: string }[]>`select topic from inbox order by topic`
      const notifyRows = await notifySql<{ topic: string }[]>`select topic from inbox order by topic`

      assert.deepEqual(
        activityRows.map((r) => r.topic),
        ['wallet.deposit.confirmed'],
        'activity’s inbox must hold only what arrived at activity’s path',
      )
      assert.deepEqual(
        notifyRows.map((r) => r.topic),
        [NOTIFY_TOPIC],
        'notify’s inbox must hold only what arrived at notify’s path',
      )

      // And the domain tables prove the same thing from the other side: each module wrote to its
      // own database and nothing crossed.
      const records = await activitySql<{ n: number }[]>`select count(*)::int as n from activity_records`
      const notifications = await notifySql<{ n: number }[]>`select count(*)::int as n from notifications`
      assert.equal(records[0]?.n, 1)
      assert.ok((notifications[0]?.n ?? 0) >= 1)
    })
  })

  /* ---------------------------------------------------------------- one of each infra route */

  describe('one process serves exactly one of each operational route', () => {
    it('/livez answers 200', async () => {
      assert.equal((await fetch(`${url}/livez`)).status, 200)
    })

    it('/metrics answers 200 and is served once', async () => {
      assert.equal((await fetch(`${url}/metrics`)).status, 200)
    })

    it("notify's three operational routes are filtered out, not shadowed by accident", () => {
      // Stated as a test rather than in a comment: the filter is what stops a dead copy of each
      // being mounted behind a live one, and a dead health endpoint looks exactly like a live one.
      const paths = notify.routes.map((route) => route.path)
      for (const operational of ['/livez', '/readyz', '/metrics']) {
        assert.ok(!paths.includes(operational), `the notify module must not mount ${operational}`)
      }
      assert.ok(paths.includes(NOTIFY_INGEST_PATH), 'and it must still mount everything else')
      assert.ok(paths.length > 5, `expected notify to mount many routes, found ${paths.length}`)
    })

    it('every mounted notify route names notify’s selector', () => {
      // The kernel resolves `ctx.sql` from `matched.sql ?? deps.sql`, and `deps.sql` is activity's.
      // A mounted route with no selector of its own is therefore handed activity's pool — silently,
      // because the two `inbox` tables agree. One missing stamp is the whole failure.
      for (const route of notify.routes) {
        assert.notEqual(
          route.sql,
          undefined,
          `${route.method} ${route.path} names no selector, so it would read activity's database`,
        )
      }
    })
  })

  /* ---------------------------------------------------------------- two network models */

  describe('the two network models coexist, and neither is imposed on the other', () => {
    it("activity REFUSES a network it holds no database for", async () => {
      // activity keeps one database per network. This fixture configured mainnet only, so a
      // testnet-stamped read must be a loud 500 rather than an answer out of mainnet rows.
      const res = await fetch(`${url}/feed`, {
        headers: { authorization: 'Bearer good-operator', 'cf-network': 'testnet' },
      })
      assert.equal(res.status, 500)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'network_unavailable')
    })

    it('notify ANSWERS the same testnet request, because its network is a column', async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * THE PLAN SAYS THE NETWORK MISMATCH "IS GONE". IT IS NOT — IT IS RECONCILED, HERE.
       *
       * notify is a class B′ singleton: one database, one pipeline, one SMTP allowance, and the
       * estate stamped on `deliveries.network`. Handing it activity's selector would make every
       * testnet notification a 500 `network_unavailable` — a regression on a working service,
       * produced by a merge that was supposed to be invisible.
       *
       * `RouteSpec.sql` is what lets both answers be right at once: the same request, on the same
       * listener, refused by one module and served by the other.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const res = await fetch(`${url}/admin/deliveries`, {
        headers: { authorization: 'Bearer good-operator', 'cf-network': 'testnet' },
      })
      assert.equal(res.status, 200, 'notify serves both estates out of one database')
    })

    it('and a testnet delivery is stamped testnet on the row rather than misfiled', async () => {
      const event = notifyEvent(BOB)
      const res = await fetch(`${url}${NOTIFY_INGEST_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-network': 'testnet',
          [SIGNATURE_HEADER]: signDelivery(event, LIVE_NOTIFY_SECRET),
        },
        body: event,
      })
      assert.equal(res.status, 202)
      const rows = await notifySql<{ network: string | null }[]>`
        select distinct network from deliveries where network is not null
      `
      assert.ok(
        rows.some((r) => r.network === 'testnet'),
        'the estate that asked travels onto the delivery — that is what the column is for',
      )
    })
  })

  /* ---------------------------------------------------------------- one /metrics, two modules */

  describe('/metrics carries both modules, and their job series do not erase each other', () => {
    it("renders both modules' domain metrics from one registry", async () => {
      const text = await scrape()
      assert.match(text, /activity_records_total/, "activity's series must be on the merged page")
      assert.match(text, /notify_ingested_total/, "notify's series must be on the merged page")
    })

    it('keeps jobs_pending as TWO series, one per module', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * THE COLLISION THIS WHOLE LABEL EXISTS FOR.
       *
       * `jobs_pending` and `jobs_overdue` carry no `kind`. Two modules calling
       * `metrics.set('jobs_pending', …)` against one registry write the IDENTICAL series, so
       * whichever samples last erases the other — and a wedged queue is then not "high" on the
       * graph, it is ABSENT from it. Nobody alerts on absent.
       *
       * `withLabels` makes each module's write a different series. Both must be present after ONE
       * scrape, which is the only arrangement in which the erasure could have happened.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const lines = (await scrape()).split('\n')
      for (const metric of ['jobs_pending', 'jobs_overdue']) {
        const series = lines.filter((line) => line.startsWith(`${metric}{`))
        assert.ok(
          series.some((line) => line.includes('module="activity"')),
          `${metric} has no activity series — the notify sample erased it:\n${series.join('\n')}`,
        )
        assert.ok(
          series.some((line) => line.includes('module="notify"')),
          `${metric} has no notify series — the activity sample erased it:\n${series.join('\n')}`,
        )
        assert.equal(series.length, 2, `${metric} must be exactly two series, one per module`)
      }
    })

    it('labels the counters that carry a kind too, so a third module stays attributable', async () => {
      // The job KINDS happen not to collide today — `activity.*` against `notify.*` — which is why
      // this wave's collision is the unlabelled pair above. Labelling the rest anyway is what stops
      // "which module is this" from being a fact you recover by parsing a kind string.
      registry.withLabels({ module: 'notify' }).increment('jobs_failed_total', { kind: 'notify.dispatch' })
      registry.withLabels({ module: 'activity' }).increment('jobs_failed_total', { kind: 'activity.inbox.prune' })

      const failed = (await scrape()).split('\n').filter((line) => line.startsWith('jobs_failed_total{'))
      assert.ok(failed.some((line) => line.includes('module="notify"')))
      assert.ok(failed.some((line) => line.includes('module="activity"')))
      for (const line of failed) assert.match(line, / 1$/, 'each module counts its own failure, not the sum')
    })

    it('renders the REGISTRY, so nothing about the page depends on which module wrote a series', async () => {
      // `/metrics` is handed the registry itself, not a view. Rendering a view would work — a view
      // shares the registry's series maps — but it reads as though the view owned the endpoint, and
      // that is what the next person adding a third module would copy.
      const text = await scrape()
      assert.match(text, /notify_deliveries_pending/, "an activity-only render would omit notify's gauges")
      assert.match(text, /notify_reserved_domain_guard/, 'the mail-quota guard gauge must survive the merge')
      assert.match(text, /activity_retention_overdue_total/)
      // And the process-wide HTTP metrics are NOT stamped with a module: one listener serves both,
      // and the `route` label already says which. A module label here would be a lie for half the
      // series on the page.
      const http = text.split('\n').filter((line) => line.startsWith('http_requests_total{'))
      assert.ok(http.length > 0, 'the kernel must have recorded the requests this suite made')
      for (const line of http) {
        assert.ok(!line.includes('module='), `http_requests_total must not claim a module: ${line}`)
      }
    })

    async function scrape(): Promise<string> {
      const res = await fetch(`${url}/metrics`)
      assert.equal(res.status, 200)
      return await res.text()
    }
  })

  /* ---------------------------------------------------------------- readiness covers both */

  describe('/readyz reflects BOTH databases', () => {
    it('names a hard probe for each module, and both pass', async () => {
      const res = await fetch(`${url}/readyz`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> }
      assert.equal(body.ready, true)
      assert.deepEqual(
        body.checks.map((c) => c.name).sort(),
        ['postgres-activity', 'postgres-notify'],
        'a merged /readyz that probes one database answers 200 while the other half is dead, and ' +
          'the balancer keeps sending traffic to it',
      )
      for (const check of body.checks) assert.equal(check.state, 'pass', `${check.name} must be passing`)
    })

    // LAST, because it destroys the notify half on purpose. It is the regression the plan names in
    // so many words, and the only way to prove it is to take that database away and read the
    // endpoint the load balancer reads.
    it('goes UNREADY when the notify database is the one that has gone', async () => {
      await notify.stop()
      stopped = true

      const res = await fetch(`${url}/readyz`)
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> }
      const notifyCheck = body.checks.find((c) => c.name === 'postgres-notify')
      assert.notEqual(notifyCheck, undefined, 'the notify probe must still be reported')
      assert.notEqual(notifyCheck?.state, 'pass', "notify's database is gone and /readyz must say so")
      assert.equal(res.status, 503)
      assert.equal(body.ready, false)

      // And activity's is still fine, so this is not "everything broke" — it is one module reported
      // honestly, which is exactly what a merged readiness has to be able to do.
      assert.equal(body.checks.find((c) => c.name === 'postgres-activity')?.state, 'pass')
    })
  })
})

/* ------------------------------------------------------------------ fixtures */

/**
 * A serialised event notify has a rule for, built through the REAL envelope builder.
 *
 * `custody.key.exported` is a §10.3 critical security topic, so the pipeline creates a notification
 * and a delivery for it whatever the recipient's preferences say — which is what makes it a usable
 * probe for "did this reach notify's database, and which estate was stamped on the row".
 *
 * `registeredEvent` is notify's own fixture over `makeEvent` from `@cloudsforge/contracts-events`.
 * Hand-rolling the envelope here would be a second copy of the contract that agrees with itself,
 * which is the failure `catalogue.test.ts` spends a whole block on.
 */
const NOTIFY_TOPIC = 'custody.key.exported'

function notifyEvent(user: string = ALICE): string {
  // The RECIPIENT varies per call, not just the key. `security.key_exported` dedupes per person,
  // so a second event for the same user is collapsed into the first notification by design — which
  // would make a case that expects a new delivery row fail for a reason unrelated to what it tests.
  return JSON.stringify(registeredEvent(NOTIFY_TOPIC, user, { user_id: user, key_id: `key-${user.slice(0, 8)}` }))
}
