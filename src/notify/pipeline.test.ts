/**
 * The pipeline, against a real database.
 *
 * These are the tests the brief asks for by name, and they are database tests because every one
 * of them is about a guarantee the database itself enforces or a state it retains:
 *
 *   - a critical notification delivered with every preference disabled;
 *   - one notification from a redelivered event, and from two events describing one fact;
 *   - a failing channel that backs off, dead-letters, and keeps the row;
 *   - a digest that batches rather than sending, and fires on its window;
 *   - an unconfigured SMTP transport recorded as `undeliverable_no_transport`;
 *   - a developer webhook whose signature a receiver can verify.
 *
 * They skip without `NOTIFY_TEST_DATABASE_URL`, and the suite runs `--test-concurrency=1` because
 * `resetNotify` truncates.
 *
 * ## Why the email fixtures are `@cloudsforge.online` and not `@example.test`
 *
 * They were `@example.test` until 2.4.0, when `reserved.ts` began refusing exactly that domain
 * (RFC 6761 §6). Nothing here is a guarantee about a DOMAIN — these tests are about backoff,
 * dead-lettering, digest windows and preference overrides — so a fixture that is silently never
 * routed to email stops testing any of them while still passing its `assert`s in six of the
 * cases below and failing in eight. CI caught it; running locally without Postgres did not.
 *
 * The estate's own domain is the honest fixture: it is deliverable, no transport is ever opened
 * (`testRig` passes one), and it cannot become reserved later. The tests that DO want a refused
 * address say `beacon.test` at the point of use, where a reader can see why.
 *
 * The webhook fixtures below keep `example.test` deliberately. The rule is scoped to
 * `channel === 'email'`, and an unreachable URL is what those tests want.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type postgres from 'postgres'
import { SIGNATURE_HEADER, verifyDelivery } from '@cloudsforge/contracts-events'
import { CATEGORIES, CHANNELS } from './model.ts'
import { emailAdapter } from './email.ts'
import { renderEmailHtml } from './emailhtml.ts'
import { webhookAdapter } from './webhook.ts'
import { dispatchDue, fanOutBroadcast, flushDueDigests, ingestEvent } from './pipeline.ts'
import {
  deliveryStats,
  insertBroadcast,
  listDeliveries,
  resendDelivery,
  listNotifications,
  upsertPreferences,
  upsertTarget,
} from './store.ts'
import type { Preference } from './routing.ts'
import {
  ALICE,
  BOB,
  enabled,
  migrateTestDb,
  openDb,
  counterValue,
  registeredEvent,
  resetNotify,
  skip,
  testRig,
  unregisteredEvent,
} from './testsupport.ts'

const WEBHOOK_SECRET = 'a-developer-webhook-secret-value'

/** Every category, every channel, switched off, muted and batched into oblivion. */
function everythingDisabled(): Preference[] {
  return CATEGORIES.flatMap((category) =>
    CHANNELS.map((channel) => ({
      category,
      channel,
      enabled: false,
      digest: 'off' as const,
      minPriority: 'critical' as const,
    })),
  )
}

describe('pipeline', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    if (!enabled) return
    sql = openDb()
    await migrateTestDb(sql)
  })

  beforeEach(async () => {
    if (!enabled) return
    await resetNotify(sql)
  })

  after(async () => {
    if (!enabled) return
    await sql.end({ timeout: 5 })
  })

  /* ---------------------------------------------------------------- the invariant */

  test('a critical notification is delivered with every preference disabled', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await upsertTarget(sql, { userId: ALICE, channel: 'sms', address: '+441234567890' })

    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    assert.equal(outcome.kind, 'processed')
    if (outcome.kind !== 'processed') return
    assert.equal(outcome.created.length, 1)

    const rows = await sql<Array<{ priority: string; channel_count: number; suppressed_reason: string | null }>>`
      select priority, channel_count, suppressed_reason from notifications
    `
    assert.equal(rows[0]?.priority, 'critical')
    assert.equal(rows[0]?.suppressed_reason, null, 'a critical notification is never suppressed')
    assert.ok((rows[0]?.channel_count ?? 0) >= 1, '04-domain-model §10.3')

    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.sent, 3, 'in-app, email and SMS all went')
    assert.ok(rig.adapters.in_app.sent.length === 1)
    assert.ok(rig.adapters.email.sent.length === 1)
    assert.ok(rig.adapters.sms.sent.length === 1)
  })

  test('a critical notification reaches a user with no addresses at all', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await dispatchDue(rig.deps, 50)

    // The floor. In-app needs no address and no transport, which is what makes "at least one
    // channel" unconditional rather than a hope that an email address is on file.
    assert.equal(rig.adapters.in_app.sent.length, 1)
  })

  test('the database itself refuses a critical notification that reached nothing', async () => {
    // The third, independent guard. Even with the routing bypassed entirely, the row cannot be
    // written — not by this service, not by a migration, not by an operator with psql.
    await assert.rejects(
      () => sql`
        insert into notifications (user_id, category, priority, template_id, channel_count)
        values (${ALICE}, 'security', 'critical', 'security.key_exported', 0)
      `,
      /notifications_critical_reaches_a_channel/,
    )
    await assert.rejects(
      () => sql`
        insert into notifications (user_id, category, priority, template_id, channel_count, suppressed_reason)
        values (${ALICE}, 'security', 'critical', 'security.key_exported', 1, 'channel_disabled')
      `,
      /notifications_critical_never_suppressed/,
    )
  })

  test('a non-critical notification with every preference disabled is recorded as suppressed', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())

    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('market.listing.sold', 'listing-1', { user_id: ALICE, item_name: 'A thing' }),
    )
    assert.equal(outcome.kind, 'processed')
    if (outcome.kind !== 'processed') return
    assert.deepEqual(outcome.suppressed, ['channel_disabled'])

    // Recorded, not discarded: "why was I not told" has to be answerable.
    const rows = await sql<Array<{ suppressed_reason: string; channel_count: number }>>`
      select suppressed_reason, channel_count from notifications
    `
    assert.equal(rows[0]?.suppressed_reason, 'channel_disabled')
    assert.equal(rows[0]?.channel_count, 0)
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
  })

  /* ---------------------------------------------------------------- deduplication */

  test('a redelivered event produces one notification, not two', async () => {
    const rig = testRig(sql)
    const event = registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' })

    const first = await ingestEvent(rig.deps, event)
    const second = await ingestEvent(rig.deps, event)

    assert.equal(first.kind, 'processed')
    // The inbox unique on (topic, event_id) won. The handler was never re-run.
    assert.deepEqual(second, { kind: 'duplicate_event' })

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 1)
  })

  test('two different events describing one fact produce one notification', async () => {
    const rig = testRig(sql)
    // A new device produces both of these, with different event ids. The inbox cannot tell they
    // are the same news; the dedupe_key can, and the unique index enforces it.
    await ingestEvent(
      rig.deps,
      registeredEvent('identity.session.created', ALICE, {
        user_id: ALICE,
        device_id: 'device-1',
        new_device: true,
        ip_prefix: '203.0.113.0/24',
      }),
    )
    const second = await ingestEvent(
      rig.deps,
      registeredEvent('identity.device.added', ALICE, { user_id: ALICE, device_id: 'device-1' }),
    )

    assert.equal(second.kind, 'processed')
    if (second.kind !== 'processed') return
    assert.deepEqual(second.suppressed, ['duplicate'])

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 1, 'one sign-in, one alert')
  })

  test('a handler that fails leaves no inbox row, so the redelivery is processed', async () => {
    const rig = testRig(sql)
    const event = registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' })

    // Force the transaction to fail after the inbox insert by making the notification insert
    // impossible: a template id longer than any column would allow is not available, so instead
    // the erasure path is used with a malformed user id, which the uuid cast rejects.
    await assert.rejects(() =>
      ingestEvent(rig.deps, {
        ...registeredEvent('identity.user.deleted', 'not-a-uuid', {}),
        key: 'not-a-uuid',
      }),
    )

    const inbox = await sql<Array<{ n: number }>>`select count(*)::int as n from inbox`
    assert.equal(inbox[0]?.n, 0, 'record-then-handle would have left a row here and lost the event')

    // And an unrelated event still works.
    assert.equal((await ingestEvent(rig.deps, event)).kind, 'processed')
  })

  /* ---------------------------------------------------------------- retries and the dead letter */

  test('a failing channel backs off before it is retried', async () => {
    const rig = testRig(sql, { backoffMs: 60_000, maxAttempts: 6 })
    rig.adapters.email.failAlways({
      ok: false,
      reason: 'upstream_error',
      retryable: true,
      detail: 'the relay is refusing connections',
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const first = await dispatchDue(rig.deps, 50)
    assert.equal(first.retried, 1)
    assert.equal(first.sent, 1, 'in-app still went; one bad channel does not stop the others')

    const rows = await sql<Array<{ state: string; attempts: number; due_in_seconds: number; last_error: string }>>`
      select state, attempts, extract(epoch from (next_attempt_at - now()))::int as due_in_seconds, last_error
        from deliveries where channel = 'email'
    `
    assert.equal(rows[0]?.state, 'pending', 'there is no "failed" state to disagree about')
    assert.equal(rows[0]?.attempts, 1)
    assert.ok((rows[0]?.due_in_seconds ?? 0) > 30, 'the next attempt is pushed out by the backoff')
    assert.match(rows[0]?.last_error ?? '', /refusing connections/)

    // And it is not claimable until then.
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
  })

  test('the welcome mail is actually emailed, to the address registration carried (micro-org#447)', async () => {
    // THE END-TO-END PROOF. `catalogue.test.ts` pins the fields; this pins the outcome, because
    // the defect was invisible at every layer except this one: the notification was created, the
    // in-app copy delivered, and the estate looked healthy while the first thing the platform
    // ever says to someone reached nobody by mail. Not once, for the life of the service.
    //
    // No `upsertTarget` before ingest, deliberately. If this test seeded the address it would
    // prove only that mail works when a target already exists, which was never in doubt — the
    // whole defect was that at registration one does NOT exist, and the event has to carry it.
    const rig = testRig(sql, { backoffMs: 0 })
    await ingestEvent(
      rig.deps,
      registeredEvent('identity.user.registered', ALICE, {
        userId: ALICE,
        handle: 'sam',
        email: 'sam@cloudsforge.online',
        organisationId: '00000000-0000-4000-8000-0000000000aa',
        organisationSlug: 'sam',
      }),
    )

    const rows = await sql<Array<{ channel: string }>>`
      select channel from deliveries where user_id = ${ALICE} and channel = 'email'
    `
    assert.equal(rows.length, 1, 'registration produced no email delivery at all — the whole defect')

    await dispatchDue(rig.deps, 50)
    assert.equal(rig.adapters.email.sent.length, 1, 'the welcome mail was not sent')
    assert.equal(
      rig.adapters.email.sent[0]?.message.address,
      'sam@cloudsforge.online',
      'sent, but not to the address the registration carried',
    )

    // ── AND IT IS THE BRANDED MAIL, NOT A BARE ONE ────────────────────────────────────────────
    //
    // The HTML shell is applied by the adapter to EVERY email (`email.ts` hands every message to
    // `renderEmailHtml`), so the welcome mail gets the same body as the verification mail by
    // construction rather than by a per-template opt-in. Asserted here anyway: "by construction"
    // is exactly what was believed about the address this test exists to prove, and the welcome
    // mail is the first thing a new account ever sees.
    const message = rig.adapters.email.sent[0]?.message
    assert.ok(message, 'nothing was handed to the transport')
    if (!message) return
    const html = renderEmailHtml({
      subject: message.subject,
      body: message.body,
      link: message.link,
      category: message.category,
    })
    assert.match(html, /<table/, 'not the table-based branded shell')
    assert.match(html, /#f4f0e8/i, 'the brand paper colour is missing')
    assert.ok(html.includes(message.link ?? ''), 'the action link is not in the HTML body')
    assert.equal(message.category, 'account')
  })

  test('support can ask what one person was sent, including the mail that worked', async () => {
    // The question this whole filter exists for. Unfiltered, the dead-letter view answers "what
    // is broken"; scoped to a person it must answer "what did we send them", and a `sent` row is
    // most of that answer. Before this, `sent` was invisible and an operator reading an empty
    // list concluded nothing had been sent.
    const rig = testRig(sql, { backoffMs: 0, maxAttempts: 3 })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await dispatchDue(rig.deps, 50)

    const dead = await listDeliveries(sql, {
      states: ['dead', 'undeliverable'],
      channel: null, userId: null, address: null, limit: 20, cursor: null,
    })
    assert.equal(dead.deliveries.length, 0, 'nothing failed, so the dead-letter view is empty')

    // Same estate, same instant, scoped to the person: the successful mail is there.
    const mine = await listDeliveries(sql, {
      states: ['pending', 'sent', 'dead', 'undeliverable'],
      channel: 'email', userId: ALICE, address: null, limit: 20, cursor: null,
    })
    assert.equal(mine.deliveries.length, 1)
    assert.equal(mine.deliveries[0]?.userId, ALICE)

    // And by the address, which is what a person quotes to support — they have never seen a uuid.
    const byAddress = await listDeliveries(sql, {
      states: ['pending', 'sent', 'dead', 'undeliverable'],
      channel: null, userId: null, address: 'ALICE@cloudsforge.online', limit: 20, cursor: null,
    })
    assert.equal(byAddress.deliveries.length, 1, 'the match is case-folded')

    const other = await listDeliveries(sql, {
      states: ['pending', 'sent', 'dead', 'undeliverable'],
      channel: null, userId: null, address: 'nobody@cloudsforge.online', limit: 20, cursor: null,
    })
    assert.equal(other.deliveries.length, 0)
  })

  test('a resend queues a NEW delivery and leaves the failure it is repeating intact', async () => {
    const rig = testRig(sql, { backoffMs: 0, maxAttempts: 2 })
    rig.adapters.email.failAlways({
      ok: false, reason: 'upstream_error', retryable: true, detail: 'the relay is refusing connections',
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    for (let pass = 0; pass < 4; pass += 1) await dispatchDue(rig.deps, 50)

    const before = await listDeliveries(sql, {
      states: ['dead', 'undeliverable'], channel: 'email', userId: null, address: null, limit: 20, cursor: null,
    })
    assert.equal(before.deliveries.length, 1)
    const original = before.deliveries[0]!

    const created = await resendDelivery(sql, original.id)
    assert.ok(created, 'a dead delivery can be resent')
    assert.notEqual(created, original.id, 'a NEW row, not the old one reset')

    // The whole point: why it failed is still readable afterwards. "Did it fail the same way
    // twice" is the question that separates a transient bounce from a dead address, and
    // resetting the original in place would have destroyed the evidence for it.
    const after = await sql<Array<{ id: string; state: string; attempts: number; last_error: string | null }>>`
      select id, state, attempts, last_error from deliveries where id = ${original.id}
    `
    assert.equal(after[0]?.state, 'dead')
    assert.equal(after[0]?.attempts, 2)
    assert.match(after[0]?.last_error ?? '', /refusing connections/)

    // Refused rather than duplicated: the new one is pending, and an operator clicking twice
    // because the first click looked like nothing happened must not send two messages.
    assert.equal(await resendDelivery(sql, created), null)
    assert.equal(await resendDelivery(sql, '00000000-0000-4000-8000-000000000000'), null)
  })

  test('a failing channel eventually dead-letters, and the row is retained', async () => {
    const rig = testRig(sql, { backoffMs: 0, maxAttempts: 3 })
    rig.adapters.email.failAlways({
      ok: false,
      reason: 'upstream_error',
      retryable: true,
      detail: 'the relay is refusing connections',
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )

    let dead = 0
    for (let pass = 0; pass < 5; pass += 1) dead += (await dispatchDue(rig.deps, 50)).dead
    assert.equal(dead, 1)

    const rows = await sql<Array<{ state: string; outcome: string; attempts: number; last_error: string }>>`
      select state, outcome, attempts, last_error from deliveries where channel = 'email'
    `
    assert.equal(rows.length, 1, 'the row is retained — it is the only record the work was asked for')
    assert.equal(rows[0]?.state, 'dead')
    assert.equal(rows[0]?.outcome, 'dead_upstream_error')
    assert.equal(rows[0]?.attempts, 3)
    assert.match(rows[0]?.last_error ?? '', /refusing connections/)

    // And it appears in the one dead-letter view, alongside every other channel.
    const page = await listDeliveries(sql, { states: ['dead', 'undeliverable'], channel: null, userId: null, address: null, limit: 20, cursor: null })
    assert.equal(page.deliveries.length, 1)
    assert.equal(page.deliveries[0]?.outcome, 'dead_upstream_error')

    // The notification itself is untouched: it is still readable in-app.
    const inApp = await listNotifications(sql, ALICE, { limit: 10, cursor: null, unreadOnly: false })
    assert.equal(inApp.notifications.length, 1)
  })

  test('an unconfigured SMTP transport is undeliverable_no_transport, not lost and not an error', async () => {
    const rig = testRig(sql, {
      override: {
        email: emailAdapter({
          smtp: { host: null, port: 587, secure: false, user: null, pass: null, from: null, replyTo: null },
        }),
      },
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.undeliverable, 1)
    assert.equal(summary.dead, 0, 'not a dead letter: no attempt budget was burned')

    const rows = await sql<Array<{ state: string; outcome: string; attempts: number }>>`
      select state, outcome, attempts from deliveries where channel = 'email'
    `
    assert.equal(rows[0]?.outcome, 'undeliverable_no_transport')
    assert.equal(rows[0]?.attempts, 1, 'tried once, then recorded; not retried five more times')

    // Not lost: the notification exists, is readable, and went out in-app.
    const page = await listNotifications(sql, ALICE, { limit: 10, cursor: null, unreadOnly: false })
    assert.equal(page.notifications.length, 1)
    assert.equal(rig.adapters.in_app.sent.length, 1)

    // Nothing is due again — this is a terminal state, so it never re-enters the queue.
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
  })

  /* ------------------------------------------------- the provider's allowance (micro-org#243) */

  /**
   * The refusal the estate's provider actually sends when its plan allowance is gone, as an
   * adapter outcome. `retryAfterMs: 0` is the test seam and not a claim about the provider: it
   * makes the parked delivery due again immediately so a loop can prove it is never dead-lettered,
   * where the real value is the ~19 minutes the provider states.
   */
  const allowanceSpent = {
    ok: false as const,
    reason: 'quota_exhausted' as const,
    retryable: true,
    detail: "the mail provider's allowance is spent, not the credentials — SMTP 535, waiting 19m",
    retryAfterMs: 0,
  }

  test('an exhausted allowance parks a verification mail; it is never dead-lettered by it', async () => {
    // `maxAttempts: 3`, so the loop below runs FOUR TIMES the budget. Before this change the same
    // shape dead-lettered on the third pass, and it did so in about thirty seconds of wall clock
    // against an allowance that resets daily — which is micro-org#243 in one sentence: the first
    // real visitor's verification link dies a day before the allowance that refused it comes back.
    const rig = testRig(sql, { maxAttempts: 3 })
    rig.adapters.email.failAlways(allowanceSpent)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      registeredEvent('identity.email.verification_requested', ALICE, {
        user_id: ALICE,
        email: 'alice@cloudsforge.online',
        token: 'a-verification-token',
      }),
    )

    for (let pass = 0; pass < 12; pass += 1) {
      const summary = await dispatchDue(rig.deps, 50)
      assert.equal(summary.dead, 0, `pass ${pass}: an allowance refusal must not dead-letter`)
    }

    const rows = await sql<Array<{ state: string; reason: string; attempts: number; last_error: string }>>`
      select state, reason, attempts, last_error from deliveries where channel = 'email'
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.state, 'pending', 'parked, not terminal — it goes out when mail comes back')
    assert.equal(rows[0]?.reason, 'quota_exhausted')
    // The attempt `claimDeliveries` charged is refunded every pass, so the budget never moves. The
    // budget counts refusals OF THIS MESSAGE, and the provider never looked at it.
    assert.equal(rows[0]?.attempts, 0, 'twelve claims spent none of a budget of three')
    // What an operator reads first says what happened in words, not just `SMTP 535`.
    assert.match(rows[0]?.last_error ?? '', /allowance is spent, not the credentials/)

    // The series to alert on, and the one that would have ended the misdiagnosis.
    assert.equal(counterValue(rig.metrics, 'notify_failed_total', { channel: 'email', reason: 'quota_exhausted' }), 12)
    // And it is visible as a standing fact, not only as a rate: "can a real person be verified
    // right now" is answerable from one gauge.
    assert.equal((await deliveryStats(sql)).awaitingAllowance, 1)

    // Nothing terminal exists to find, because nothing was given up on.
    const page = await listDeliveries(sql, { states: ['dead', 'undeliverable'], channel: null, userId: null, address: null, limit: 20, cursor: null })
    assert.equal(page.deliveries.length, 0)

    // The allowance resets. The mail that was waiting for it goes out — the assertion that makes
    // "parked" different from "quietly lost".
    rig.adapters.email.reset()
    const after = await dispatchDue(rig.deps, 50)
    assert.equal(after.sent, 1)
    assert.equal(rig.adapters.email.sent.length, 1)
    assert.equal((await deliveryStats(sql)).awaitingAllowance, 0)
  })

  test('the parking is bounded by one allowance period, so nothing waits for ever', async () => {
    // A refund with no bound is a row that retries silently for ever and never reaches the
    // dead-letter view — a message nobody delivered and nobody can find, which is worse than a
    // dead letter. After one provider day plus an hour of clock slack, attempts are charged again.
    const rig = testRig(sql, { maxAttempts: 2 })
    rig.adapters.email.failAlways(allowanceSpent)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await dispatchDue(rig.deps, 50)

    // Age the row past the bound. The clock that matters is the database's, which is the clock
    // `created_at` and `now()` are both read from.
    await sql`update deliveries set created_at = now() - interval '26 hours' where channel = 'email'`

    let dead = 0
    for (let pass = 0; pass < 5; pass += 1) dead += (await dispatchDue(rig.deps, 50)).dead
    assert.equal(dead, 1, 'past the bound it behaves like any other retryable failure')

    const rows = await sql<Array<{ state: string; outcome: string }>>`
      select state, outcome from deliveries where channel = 'email'
    `
    assert.equal(rows[0]?.state, 'dead')
    // Terminal, and spelled with the reason — so the dead-letter view says why in one column.
    assert.equal(rows[0]?.outcome, 'dead_quota_exhausted')
  })

  /* ---------------------------------------------------------------- digests */

  test('a digest preference batches rather than sending, and the batch fires on its schedule', async () => {
    const at = new Date('2026-07-30T10:20:00.000Z')
    const rig = testRig(sql, { now: () => at })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await upsertPreferences(sql, ALICE, [
      { category: 'transfer', channel: 'email', enabled: true, digest: 'hourly', minPriority: 'low' },
      { category: 'transfer', channel: 'in_app', enabled: true, digest: 'hourly', minPriority: 'low' },
    ])

    for (const entry of ['entry-1', 'entry-2', 'entry-3']) {
      await ingestEvent(
        rig.deps,
        registeredEvent('ledger.entry.posted', 'account-1', {
          user_id: ALICE,
          entry_id: entry,
          amount: '5',
          asset_code: 'SHARD',
          description: 'a marketplace fee',
        }),
      )
    }

    // Nothing sent. The whole point of a digest is that the interruption does not happen now.
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
    const batched = await sql<Array<{ n: number }>>`select count(*)::int as n from digest_entries`
    assert.equal(batched[0]?.n, 6, 'three notifications, two channels')

    const windows = await sql<Array<{ scheduled_for: Date; cadence: string }>>`
      select scheduled_for, cadence from digests order by channel
    `
    // Aligned to the wall clock: the top of the next hour, not "an hour from the first item".
    assert.equal(windows[0]?.scheduled_for.toISOString(), '2026-07-30T11:00:00.000Z')

    // Before the window, nothing fires.
    assert.equal((await flushDueDigests(rig.deps, 50)).flushed, 0)

    // On the window, one summary per channel, each carrying all three.
    const later = testRig(sql, { now: () => new Date('2026-07-30T11:00:01.000Z') })
    const flushed = await flushDueDigests(later.deps, 50)
    assert.equal(flushed.flushed, 2)
    assert.equal(flushed.notifications, 2)

    await dispatchDue(later.deps, 50)
    const summaries = later.adapters.email.sent
    assert.equal(summaries.length, 1)
    assert.match(summaries[0]?.message.subject ?? '', /3 updates/)
    // Each line distinguishes its notification. A digest of three identical lines is worse than
    // no digest, and this assertion is what keeps a parameterless subject out of a batch.
    assert.match(summaries[0]?.message.body ?? '', /5 SHARD/)
    assert.equal(summaries[0]?.message.body.split('\n').filter((line) => line.startsWith('•')).length, 3)

    // Flushing again is a no-op: the batch is closed and the summary deduped on the digest id.
    assert.equal((await flushDueDigests(later.deps, 50)).flushed, 0)
  })

  /* ---------------------------------------------------------------- webhooks */

  test('a webhook delivery carries a signature the receiver can verify', async () => {
    let verified: ReturnType<typeof verifyDelivery> | null = null
    let body = ''
    const rig = testRig(sql, {
      override: {
        webhook: webhookAdapter({
          // A third-party application, verifying with the shared package rather than
          // recomputing an HMAC of its own.
          post: async (_url, request) => {
            body = request.body
            verified = verifyDelivery(request.body, request.headers[SIGNATURE_HEADER] ?? '', WEBHOOK_SECRET)
            return { status: 200 }
          },
        }),
      },
    })
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://developer.example.test/hooks/cf',
      secret: WEBHOOK_SECRET,
      label: 'Acme integration',
    })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.sent, 2, 'in-app and the webhook — one pipeline, not two')
    assert.deepEqual(verified, { ok: true, keyIndex: 0 })

    const payload = JSON.parse(body) as Record<string, unknown>
    assert.equal(payload['userId'], ALICE)
    assert.equal(payload['category'], 'security')
    // The internal envelope is never forwarded to a third party.
    assert.equal(payload['topic'], undefined)
    assert.equal(payload['producer'], undefined)
  })

  test('a webhook is retried and dead-lettered by the same policy as an email', async () => {
    const rig = testRig(sql, { backoffMs: 0, maxAttempts: 2 })
    rig.adapters.webhook.failAlways({
      ok: false,
      reason: 'upstream_error',
      retryable: true,
      detail: 'endpoint answered 502',
    })
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://developer.example.test/hooks/cf',
      secret: WEBHOOK_SECRET,
    })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    for (let pass = 0; pass < 3; pass += 1) await dispatchDue(rig.deps, 50)

    const page = await listDeliveries(sql, {
      states: ['dead', 'undeliverable'],
      channel: 'webhook',
      userId: null,
      address: null,
      limit: 10,
      cursor: null,
    })
    assert.equal(page.deliveries.length, 1)
    assert.equal(page.deliveries[0]?.state, 'dead')
    assert.equal(page.deliveries[0]?.attempts, 2)
  })

  test('one broken webhook endpoint does not stop the others', async () => {
    const rig = testRig(sql, { backoffMs: 60_000 })
    let calls = 0
    const failing = 'https://broken.example.test/hooks'
    const rigWithReceiver = testRig(sql, {
      backoffMs: 60_000,
      override: {
        webhook: webhookAdapter({
          post: async (url) => {
            calls += 1
            return { status: url === failing ? 500 : 200 }
          },
        }),
      },
    })
    void rig

    await upsertTarget(sql, { userId: ALICE, channel: 'webhook', address: failing, secret: WEBHOOK_SECRET })
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://working.example.test/hooks',
      secret: WEBHOOK_SECRET,
    })

    await ingestEvent(
      rigWithReceiver.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const summary = await dispatchDue(rigWithReceiver.deps, 50)
    assert.equal(calls, 2, 'one delivery row per endpoint, each with its own attempts')
    assert.equal(summary.sent, 2, 'in-app and the working endpoint')
    assert.equal(summary.retried, 1)
  })

  /* ---------------------------------------------------------------- registry lag, erasure, broadcast */

  /**
   * This used to ingest `identity.password.changed` and assert a "password was changed" subject.
   * It passed, and the notification it proved could never happen: identity emits no such topic. It
   * revokes every session with a reason (identity/src/server.ts), which is the event below.
   */
  test('a password change reaches the user as the session revocation identity really emits', async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('identity.session.revoked', 'session-1', {
        sessionId: 'session-1',
        userId: ALICE,
        reason: 'password_changed',
      }),
    )
    assert.equal(outcome.kind, 'processed')
    await dispatchDue(rig.deps, 50)
    assert.match(rig.adapters.in_app.sent[0]?.message.subject ?? '', /session .* was ended/i)
    assert.match(rig.adapters.in_app.sent[0]?.message.body ?? '', /your password was changed/)
  })

  test('an ordinary sign-out is not news, and is recorded as such', async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('identity.session.revoked', 'session-2', {
        sessionId: 'session-2',
        userId: ALICE,
        reason: 'signed_out',
      }),
    )
    // `not_applicable`, never `no_recipient`: the rule found the user and decided, which is the
    // distinction an operator reads to know whether a producer needs fixing.
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'not_applicable' })
  })

  test('an event on a topic no rule covers is ignored rather than stored as a notification', async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      unregisteredEvent('identity.password.changed', ALICE, { user_id: ALICE }),
    )
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'no_rule' })
  })

  test('identity.user.deleted erases everything this service holds', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await upsertPreferences(sql, ALICE, [
      { category: 'market', channel: 'email', enabled: false, digest: 'off', minPriority: 'low' },
    ])
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', BOB, { user_id: BOB, key_id: 'key-2' }),
    )

    const erased = await ingestEvent(rig.deps, registeredEvent('identity.user.deleted', ALICE, { user_id: ALICE }))
    assert.equal(erased.kind, 'erased')

    const mine = await sql<Array<{ n: number }>>`
      select (select count(*) from notifications where user_id = ${ALICE})
           + (select count(*) from channel_targets where user_id = ${ALICE})
           + (select count(*) from preferences where user_id = ${ALICE}) as n
    `
    assert.equal(Number(mine[0]?.n), 0)
    // Deliveries go by cascade, and nobody else is touched.
    const theirs = await sql<Array<{ n: number }>>`
      select count(*)::int as n from notifications where user_id = ${BOB}
    `
    assert.equal(theirs[0]?.n, 1)
  })

  test('an operator broadcast reaches every reachable user exactly once', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await upsertTarget(sql, { userId: BOB, channel: 'email', address: 'bob@cloudsforge.online' })

    const broadcast = await insertBroadcast(sql, {
      category: 'system',
      priority: 'normal',
      templateId: 'system.broadcast',
      params: { title: 'Scheduled maintenance', message: 'Withdrawals pause at 02:00 UTC.' },
      audience: 'all',
      userIds: [],
      dedupeKey: 'broadcast:maintenance-2026-07-30',
      createdBy: 'operator:root',
    })

    const first = await fanOutBroadcast(rig.deps, broadcast.id)
    assert.equal(first.recipients, 2)
    assert.equal(first.created, 2)

    // Re-running the fan-out after a crash produces nothing new: the dedupe key is per user.
    const second = await fanOutBroadcast(rig.deps, broadcast.id)
    assert.equal(second.created, 0)

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 2)
  })

  /* ---------------------------------------------------------------- the failed withdrawal
   *
   * The whole path for `settlement.outbound.failed`, from settlement's real payload to the words
   * a channel is handed, because every intermediate step has somewhere for the fact to be lost:
   * the rule picks the recipient, `outcomeOf` picks the priority and template, the database's two
   * §10.3 CHECK constraints decide whether a critical row may exist at all, and the renderer
   * produces the sentence. A unit test on the rule alone proves none of the last three.
   *
   * `WITHDRAWAL` is a uuid that is NOT a user's, because it is the envelope key for this topic and
   * a key fallback would be well-formed and wrong.
   */

  const WITHDRAWAL = '44444444-4444-4444-8444-444444444444'

  function failure(payload: Record<string, unknown>) {
    // `service:settlement` is what settlement's relay stamps: `failedEvents` names no actor, so
    // there is no actor route to a person and the payload is the only one.
    return registeredEvent('settlement.outbound.failed', WITHDRAWAL, payload, {
      actor: 'service:settlement',
    })
  }

  /**
   * Held money is critical, so it survives a user who has muted everything.
   *
   * This is the §10.3 invariant applied to the case it was not written for, and the reason it has
   * to hold here is specific: wallet's non-refundable branch moves the row to `stuck` and emits
   * nothing (`wallet/src/withdrawals.ts`), so this notification is the only account the owner
   * of that money will ever get. A preference that could silence it would turn "your withdrawal
   * failed and your funds are held" into silence.
   */
  test('a failed withdrawal with the money held reaches a user who has muted everything', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    const outcome = await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'the chain rejected it', refundable: false }),
    )
    assert.equal(outcome.kind, 'processed')

    const rows = await sql<
      Array<{ user_id: string; priority: string; template_id: string; channel_count: number; suppressed_reason: string | null }>
    >`select user_id, priority, template_id, channel_count, suppressed_reason from notifications`
    assert.equal(rows.length, 1)
    // The right person: settlement's userId, never the withdrawal id the envelope is keyed by.
    assert.equal(rows[0]?.user_id, ALICE)
    assert.notEqual(rows[0]?.user_id, WITHDRAWAL)
    assert.equal(rows[0]?.priority, 'critical')
    assert.equal(rows[0]?.template_id, 'withdrawal.failed_held')
    assert.equal(rows[0]?.suppressed_reason, null, '04-domain-model §10.3')
    assert.ok((rows[0]?.channel_count ?? 0) >= 1)

    await dispatchDue(rig.deps, 50)
    const sent = [...rig.adapters.in_app.sent, ...rig.adapters.email.sent]
    assert.equal(sent.length, 2, 'in-app and email, with every preference switched off')
    for (const { message } of sent) {
      assert.equal(message.userId, ALICE)
      const text = `${message.subject}\n${message.body}`
      assert.match(text, /still held/)
      assert.doesNotMatch(
        text,
        /coming back|being returned to your balance/,
        'the expensive error, delivered: their money is held and they have been told it is back',
      )
    }
  })

  test('a refundable failure says the money is coming back, and is muteable', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'the chain rejected it', refundable: true }),
    )
    const rows = await sql<Array<{ user_id: string; priority: string; template_id: string }>>`
      select user_id, priority, template_id from notifications
    `
    assert.equal(rows[0]?.user_id, ALICE)
    assert.equal(rows[0]?.priority, 'high')
    assert.equal(rows[0]?.template_id, 'withdrawal.failed_refunded')

    await dispatchDue(rig.deps, 50)
    const email = rig.adapters.email.sent[0]?.message
    const text = `${email?.subject}\n${email?.body}`
    assert.match(text, /being returned to your balance/)
    assert.doesNotMatch(text, /still held/)

    // And `high` really is muteable, which is the half of the priority argument a unit test on the
    // rule cannot show: the same event, for a user who has switched the category off, is
    // suppressed rather than forced through. That is the difference from the test above, and it is
    // the reason the two dispositions are not one priority.
    await upsertPreferences(sql, BOB, everythingDisabled())
    const muted = await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, userId: BOB, reason: 'the chain rejected it', refundable: true }),
    )
    assert.equal(muted.kind, 'processed')
    if (muted.kind !== 'processed') return
    assert.deepEqual(muted.created, [])
    assert.equal(muted.suppressed.length, 1)
  })

  /**
   * **Yesterday's payload, through the whole pipeline.**
   *
   * The trap this exists for: an end-to-end test that only ever sends today's payload stays GREEN
   * with the recipient logic deliberately broken, because an absent field is null to every reader
   * and a rule that guesses from the key produces a notification that looks perfectly well formed.
   * It has a user id, it has a template, it renders. It goes to a user who does not exist.
   *
   * So the pre-fix shape — `{ withdrawalId, reason, refundable }`, exactly what `failedEvents`
   * emitted before settlement added the field — is driven through `ingestEvent`, and the assertion
   * is that NOTHING is written. `no_recipient` is the honest answer and it names a producer to go
   * and fix; a row here would mean this service had invented a recipient.
   */
  test("yesterday's failure payload writes no notification at all, rather than one for nobody", async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, reason: 'the chain rejected it', refundable: false }),
    )
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'no_recipient' })

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 0, 'a notification was written for a recipient nobody named')
    // And the absence is counted, so an operator sees a producer to page rather than silence.
    assert.equal(counterValue(rig.metrics, 'notify_suppressed_total', { reason: 'no_recipient' }), 1)
  })

  /**
   * The regression that costs the most, driven end to end: the producer stops sending `refundable`.
   *
   * settlement made it a required boolean, so this is a relay dropping a field, a replay of an old
   * event, or a rewrite that made it optional again. In every one of those the truthful answer is
   * "we do not know", and the notification must read as HELD — because `wallet/src/server.ts`
   * refuses to refund without proof, and a notification saying the money is on its way back while
   * wallet holds it is the one error nobody can take back.
   */
  test('a failure payload with refundable dropped is delivered as HELD, not as a refund', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    await ingestEvent(rig.deps, failure({ withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'unknown' }))
    const rows = await sql<Array<{ priority: string; template_id: string }>>`
      select priority, template_id from notifications
    `
    assert.equal(rows[0]?.priority, 'critical')
    assert.equal(rows[0]?.template_id, 'withdrawal.failed_held')

    await dispatchDue(rig.deps, 50)
    const email = rig.adapters.email.sent[0]?.message
    const text = `${email?.subject}\n${email?.body}`
    assert.match(text, /still held/)
    assert.doesNotMatch(text, /coming back|being returned to your balance/)
  })

  /* ---------------------------------------------------------------- tessera's two owner topics
   *
   * `tessera.parcel.fallowed` and `tessera.venue.booked` were refused a rule twice, recorded
   * `blockedBy: 'no-subject'`, because the envelope named the CHALLENGER and the BOOKER. tessera
   * 33ead39 added `ownerSubject` to both, read off the `parcels` row the emitting transaction
   * already held `for update`.
   *
   * `catalogue.test.ts` grades the rule. These grade the four things after it that a unit test on
   * the rule cannot see — the row the pipeline writes, the priority the preference filter applies
   * to it, the words the renderer builds, and which address the adapter is handed — because the
   * failure worth catching here is not "no notification". It is **a notification, well formed and
   * delivered, to Bob.** ALICE owns; BOB acts; every assertion below is a difference.
   *
   * `PARCEL` is a uuid that is nobody's user id, because it is the envelope key for both topics and
   * a key fallback would be well formed and wrong.
   */

  const PARCEL = '55555555-5555-4555-8555-555555555555'
  const CONTEST = '66666666-6666-4666-8666-666666666666'
  const BOOKING = '77777777-7777-4777-8777-777777777777'
  const SLOT = '2026-09-01T18:00:00.000Z'

  /** `openContest`, tessera/src/world.ts: actor is the CHALLENGER, key is the parcel. */
  function fallowed(payload: Record<string, unknown>) {
    return registeredEvent('tessera.parcel.fallowed', PARCEL, payload, { actor: `user:${BOB}` })
  }

  /** `bookVenue`, tessera/src/economy.ts: actor is the BOOKER, key is the parcel. */
  function booked(payload: Record<string, unknown>) {
    return registeredEvent('tessera.venue.booked', PARCEL, payload, { actor: `user:${BOB}` })
  }

  test('a contest reaches the owner losing the ground, and never the challenger who opened it', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await upsertTarget(sql, { userId: BOB, channel: 'email', address: 'bob@cloudsforge.online' })

    const outcome = await ingestEvent(
      rig.deps,
      fallowed({
        parcelId: PARCEL,
        wardId: 'ward-1',
        contestId: CONTEST,
        ownerSubject: `user:${ALICE}`,
        challengerSubject: `user:${BOB}`,
      }),
    )
    assert.equal(outcome.kind, 'processed')

    const rows = await sql<Array<{ user_id: string; priority: string; template_id: string }>>`
      select user_id, priority, template_id from notifications
    `
    assert.equal(rows.length, 1, 'the challenger was told about their own contest as well')
    assert.equal(rows[0]?.user_id, ALICE)
    assert.notEqual(rows[0]?.user_id, BOB, 'the actor on this envelope')
    assert.notEqual(rows[0]?.user_id, PARCEL, 'the envelope key')
    assert.equal(rows[0]?.priority, 'high')
    assert.equal(rows[0]?.template_id, 'tessera.parcel_contested')

    await dispatchDue(rig.deps, 50)
    // Not one message to Bob on any channel — the assertion the rule-level test cannot make,
    // because a second recipient would only appear once the pipeline has fanned out.
    for (const recorder of Object.values(rig.adapters)) {
      for (const { message } of recorder.sent) {
        assert.equal(message.userId, ALICE, 'a message was addressed to somebody who is not the owner')
      }
    }
    const email = rig.adapters.email.sent[0]?.message
    assert.equal(email?.address, 'alice@cloudsforge.online')
    const text = `${email?.subject}\n${email?.body}`
    assert.match(text, new RegExp(PARCEL), 'which parcel — a reader may hold dozens')
    assert.match(text, /still yours/, 'what is NOT lost, or the reader learns only that they lost')
    // Bad news, in the second person, about the reader's own ground: it must not read as a
    // congratulation to a challenger, which is what the same words sent to Bob would be.
    assert.doesNotMatch(text, /you have contested|your contest|congratul/i)
  })

  test('a venue booking reaches the owner being paid, and never the booker who made it', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })
    await upsertTarget(sql, { userId: BOB, channel: 'email', address: 'bob@cloudsforge.online' })

    await ingestEvent(
      rig.deps,
      booked({
        bookingId: BOOKING,
        parcelId: PARCEL,
        wardId: 'ward-1',
        slot: SLOT,
        ownerSubject: `user:${ALICE}`,
        bookedBy: `user:${BOB}`,
        priceWei: '5000000000000',
        reservationId: 'res-1',
      }),
    )

    const rows = await sql<Array<{ user_id: string; priority: string; template_id: string }>>`
      select user_id, priority, template_id from notifications
    `
    assert.equal(rows.length, 1)
    // The expensive one: `bookedBy` is also the actor, so both of the obvious implementations
    // resolve Bob and tell the booker that they are owed money for their own booking.
    assert.equal(rows[0]?.user_id, ALICE)
    assert.notEqual(rows[0]?.user_id, BOB)
    assert.notEqual(rows[0]?.user_id, PARCEL)
    assert.equal(rows[0]?.priority, 'high')
    assert.equal(rows[0]?.template_id, 'tessera.venue_booked')

    await dispatchDue(rig.deps, 50)
    for (const recorder of Object.values(rig.adapters)) {
      for (const { message } of recorder.sent) {
        assert.equal(message.userId, ALICE)
      }
    }
    const email = rig.adapters.email.sent[0]?.message
    assert.equal(email?.address, 'alice@cloudsforge.online')
    const text = `${email?.subject}\n${email?.body}`
    assert.match(text, /2026-09-01 18:00 UTC/)
    assert.match(text, /escrowed/)
    // The raw wei figure, delivered. It is a whole multiple of 10^12 and the divisor that turns it
    // into Sparks lives in micro-tessera and is exported by nothing, so the sentence names no
    // amount at all rather than a wrong one or an unreadable one.
    assert.doesNotMatch(text, /5000000000000/)
  })

  /**
   * `high` and not `critical`, proved by the only thing that can tell them apart.
   *
   * The catalogue test pins the literal, which a rule change edits in one place. This shows the
   * consequence: a reader who has muted everything hears NOTHING about their venue, and that is
   * the intended behaviour — the fee is escrowed in a ledger reservation `bookings_open_holds_money`
   * makes non-optional, so a silenced notification costs a heads-up rather than money. It is the
   * same test the failed-withdrawal rule applied to reach the opposite answer for HELD funds, and
   * running it in the direction that produces silence is what keeps the critical set at five.
   */
  test('a booking is suppressed for an owner who has muted everything — it is high, not critical', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@cloudsforge.online' })

    const outcome = await ingestEvent(
      rig.deps,
      booked({
        bookingId: BOOKING,
        parcelId: PARCEL,
        slot: SLOT,
        ownerSubject: `user:${ALICE}`,
        bookedBy: `user:${BOB}`,
        priceWei: '5000000000000',
        reservationId: 'res-1',
      }),
    )
    assert.equal(outcome.kind, 'processed')
    if (outcome.kind !== 'processed') return
    assert.deepEqual(outcome.created, [], 'a critical would have been forced through §10.3')
    assert.equal(outcome.suppressed.length, 1)

    await dispatchDue(rig.deps, 50)
    assert.equal(rig.adapters.email.sent.length, 0)
  })

  /**
   * **Yesterday's payloads, through the whole pipeline, for both topics.**
   *
   * These are the shapes `openContest` and `bookVenue` emitted before tessera 33ead39, and they are
   * the trap this estate hit twice in one night: an end-to-end test fed only today's payload stays
   * GREEN with the recipient logic broken, because an absent field is null to every reader and a
   * rule that falls back to the actor produces a notification that is well formed, addressable and
   * renders perfectly. It goes to the challenger, or to the booker.
   *
   * So both are driven through `ingestEvent` and the assertion is that NOTHING is written.
   * `no_recipient` is the honest answer and it names a producer to go and fix; a row here would
   * mean this service had invented a recipient out of the only user id on the envelope.
   */
  test("yesterday's tessera payloads write nothing, rather than a notification for the actor", async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: BOB, channel: 'email', address: 'bob@cloudsforge.online' })

    // `{ parcelId, contestId, challengerSubject }` — no owner, and Bob on the actor and the payload.
    const contest = await ingestEvent(
      rig.deps,
      fallowed({ parcelId: PARCEL, contestId: CONTEST, challengerSubject: `user:${BOB}` }),
    )
    assert.deepEqual(contest, { kind: 'ignored', reason: 'no_recipient' })

    // `{ bookingId, parcelId, slot, bookedBy, priceWei, reservationId }` — likewise.
    const booking = await ingestEvent(
      rig.deps,
      booked({
        bookingId: BOOKING,
        parcelId: PARCEL,
        slot: SLOT,
        bookedBy: `user:${BOB}`,
        priceWei: '5000000000000',
        reservationId: 'res-1',
      }),
    )
    assert.deepEqual(booking, { kind: 'ignored', reason: 'no_recipient' })

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 0, 'a notification was written for a recipient nobody named')
    await dispatchDue(rig.deps, 50)
    assert.equal(rig.adapters.email.sent.length, 0, 'the actor was told about his own act')
    // Counted, so an operator sees a producer to page rather than silence. Two events, two counts.
    assert.equal(counterValue(rig.metrics, 'notify_suppressed_total', { reason: 'no_recipient' }), 2)
  })

  /* ---------------------------------------------------------------- how notify learns an address
   *
   * **No user in this estate has ever had an email address in this service.** `upsertTarget`
   * (`store.ts`) had exactly one caller when this section was written, and it was this file:
   * nothing in `server.ts` creates a channel target and nothing in `pipeline.ts` did either. So
   * `channelsAvailable` (`pipeline.ts`) returned `['in_app']` for every real user, `resolveRouting`
   * routed to the floor channel and nowhere else, and every email notification the service has ever
   * produced was delivered in-app and silently to nobody by mail. The owner reported it the way it
   * presents from outside: "I didn't receive any registration email."
   *
   * The four tests below are the two halves of the repair, each driven end to end:
   *
   *   - an event that CARRIES an address teaches this service the address, in the same transaction
   *     that writes the notification, so the very mail that taught it goes out;
   *   - a notification that could have gone by email and reached nobody is COUNTED, on a deployment
   *     whose transport works, so the residue — every account registered before this landed — is a
   *     number an operator can read rather than a silence.
   */

  /**
   * Obviously not a credential, and it must stay that way.
   *
   * A verification link is a single-use bearer token in a URL. This one is a fixture, so it says so
   * in its own path; a fixture that looks like a live link is one grep away from being read as a
   * leak, and this repository's own rule is that no test prints anything that resembles a secret.
   */
  const VERIFY_LINK = 'https://app.cloudsforge.test/verify/this-is-not-a-real-token'

  const verification = (payload: Record<string, unknown>) =>
    unregisteredEvent('identity.email.verification_requested', ALICE, payload, {
      actor: `user:${ALICE}`,
    })

  test('a verification request teaches notify the address, and the first mail actually goes', async () => {
    const rig = testRig(sql)

    const outcome = await ingestEvent(
      rig.deps,
      verification({
        userId: ALICE,
        handle: 'alice',
        email: 'alice@cloudsforge.online',
        verifyUrl: VERIFY_LINK,
      }),
    )
    assert.equal(outcome.kind, 'processed')

    const targets = await sql<Array<{ channel: string; address: string; verified_at: Date | null }>>`
      select channel, address, verified_at from channel_targets where user_id = ${ALICE} and active
    `
    assert.equal(targets.length, 1, 'the event carried an address and this service kept it')
    assert.equal(targets[0]?.channel, 'email')
    assert.equal(targets[0]?.address, 'alice@cloudsforge.online')
    assert.equal(targets[0]?.verified_at, null, 'unverified: identity has not said the address is real')

    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.sent, 2, 'in-app and, for the first time in this service, email')
    const mail = rig.adapters.email.sent[0]?.message
    assert.equal(mail?.address, 'alice@cloudsforge.online')
    assert.equal(mail?.link, VERIFY_LINK, 'the link in the mail is the one identity minted')
    assert.match(mail?.subject ?? '', /confirm/i)
  })

  test('a second request at a new address replaces the first, rather than mailing both', async () => {
    // identity holds ONE address per user (`users_email_lower_uniq`), so this service's mirror of
    // it holds one too. `channel_targets_uniq` is on (user, channel, address), so a plain upsert of
    // a changed address leaves two ACTIVE rows — and `deliveriesFor` writes one delivery per
    // target, deliberately, so a developer's three webhook endpoints all fire. Applied to a learned
    // address that means every LATER notification sent twice, one of them to an inbox the person
    // has already given up.
    const rig = testRig(sql)
    await ingestEvent(rig.deps, verification({ userId: ALICE, handle: 'alice', email: 'old@cloudsforge.online', verifyUrl: VERIFY_LINK }))
    await ingestEvent(rig.deps, verification({ userId: ALICE, handle: 'alice', email: 'new@cloudsforge.online', verifyUrl: VERIFY_LINK }))

    const rows = await sql<Array<{ address: string; active: boolean }>>`
      select address, active from channel_targets where user_id = ${ALICE} and channel = 'email'
      order by address
    `
    assert.deepEqual(rows.map((row) => ({ address: row.address, active: row.active })), [
      // Deactivated rather than deleted: `deliveries.target_id` is `on delete set null`, and
      // blanking it would erase which address every message already sent there went to.
      { address: 'new@cloudsforge.online', active: true },
      { address: 'old@cloudsforge.online', active: false },
    ])

    // The LATER notification is the one that must not double. Each verification mail is still
    // addressed to the inbox whose link it carries — the first one was minted for old@ and
    // delivering it anywhere else would prove nothing about that address.
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await dispatchDue(rig.deps, 50)
    const alerted = rig.adapters.email.sent
      .filter((each) => each.message.templateId === 'security.key_exported')
      .map((each) => each.message.address)
    assert.deepEqual(alerted, ['new@cloudsforge.online'], 'one alert, to the address in use')
  })

  /**
   * The half that makes the residue visible.
   *
   * Every account that existed before the repair has no address here and will not get one until an
   * event carrying it arrives. That population is exactly the owner's complaint, and the thing that
   * must not happen again is it being invisible: an email-category notification on a deployment
   * with a WORKING transport, reaching nobody by mail, previously produced no delivery row, no log
   * line, no metric and nothing in `GET /admin/deliveries`.
   */
  test('a working mailer that reaches nobody is counted, not silent', async () => {
    const rig = testRig(sql, { emailConfigured: true })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )

    assert.equal(
      counterValue(rig.metrics, 'notify_failed_total', { channel: 'email', reason: 'no_address' }),
      1,
      'a configured mailer reached nobody and nothing counted it',
    )
  })

  test('an unconfigured mailer counts nothing, because sending no mail is a supported way to run', async () => {
    // `no_transport` is the honest reading for a deployment with no SMTP (see `email.ts`), and it
    // is already counted where it happens. Counting `no_address` as well would put a permanent
    // non-zero rate on the one series an operator would use to alert on broken mail, which is how
    // a signal becomes wallpaper.
    const rig = testRig(sql, { emailConfigured: false })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )

    assert.equal(
      counterValue(rig.metrics, 'notify_failed_total', { channel: 'email', reason: 'no_address' }),
      0,
    )
  })

  /**
   * The monitor's own accounts, which are what actually exhausted the estate's mail allowance.
   *
   * `beacon` registers a throwaway account per synthetic journey at `beacon+<hex>@beacon.test` —
   * measured at ~95/hour, and 7,319 of mainnet's 7,398 user rows. Every one of them was routed to
   * email, tried, failed, and retried six times, which spent a 250/day provider allowance within
   * minutes. After that a real visitor's verification mail returned `SMTP 535` and their address
   * could never be confirmed: 4,483 tokens issued across the two networks, none ever consumed.
   */
  test('an address under a reserved domain is not routed to email at all', async () => {
    const rig = testRig(sql, { emailConfigured: true })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'beacon+9f2a@beacon.test' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await dispatchDue(rig.deps, 50)

    // No delivery row was ever written, which is the load-bearing claim: not "it failed cheaply"
    // but "it was never attempted". A row would be retried `max_attempts` times and then
    // dead-lettered, and it is that multiplier that turned one monitor into a quota outage.
    const rows = await sql<Array<{ n: number }>>`
      select count(*)::int as n from deliveries where channel = 'email'
    `
    assert.equal(rows[0]?.n, 0, 'no email delivery row exists for an address that cannot resolve')
    assert.equal(rig.adapters.email.sent.length, 0, 'the transport was never opened')

    // The notification itself still happened. Suppressing the CHANNEL is the fix; suppressing the
    // notification would blind the monitor to fix the monitor's side effect.
    assert.ok(rig.adapters.in_app.sent.length >= 1, 'the floor channel is unconditional')
  })

  test('a reserved domain is not reported as a user with no address on file', async () => {
    // Without this, edit 2 makes `reportUnaddressed` fire for every one of beacon's ~95 an hour,
    // burying the real signal — an account that genuinely has no address — at roughly ninety to
    // one. Nothing failed here: there was never anybody at the other end.
    const rig = testRig(sql, { emailConfigured: true })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'beacon+9f2a@beacon.test' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )

    assert.equal(
      counterValue(rig.metrics, 'notify_failed_total', { channel: 'email', reason: 'no_address' }),
      0,
      'an unroutable address is not the same finding as a missing one',
    )
  })

  /**
   * The link is a single-use credential, and this is every route it could have left by.
   *
   * It arrives on an event, is stored in `notifications.params`, and goes out in a mail body. The
   * three ways it could escape are the two read routes and the dead-letter view — `GET
   * /notifications` returns the whole `params` object, and an operator with the admin role may read
   * any user's notifications (`server.ts`, the `isAdmin(principal) && requested` line). An operator
   * who can read a verification link can take the account.
   */
  test('the verification link never leaves by an HTTP route, only by mail', async () => {
    const rig = testRig(sql)
    await ingestEvent(
      rig.deps,
      verification({ userId: ALICE, handle: 'alice', email: 'alice@cloudsforge.online', verifyUrl: VERIFY_LINK }),
    )

    const page = await listNotifications(sql, ALICE, { limit: 10, cursor: null, unreadOnly: false })
    assert.equal(page.notifications.length, 1)
    const params = page.notifications[0]?.params ?? {}
    assert.equal(
      JSON.stringify(page).includes('this-is-not-a-real-token'),
      false,
      'the verification link is readable over HTTP',
    )
    assert.equal(params['verifyUrl'], '[redacted]', 'redacted visibly, not dropped as if never sent')
    assert.equal(params['handle'], 'alice', 'and the parameters that are not credentials survive')

    // The mail still carries it: the redaction is at the HTTP boundary, not in the stored row.
    await dispatchDue(rig.deps, 50)
    assert.equal(rig.adapters.email.sent[0]?.message.link, VERIFY_LINK)
  })

  /**
   * A developer webhook is a third party's URL, and this notification's link is a bearer token.
   *
   * `deliveriesFor` writes one delivery per target, so a user holding a webhook endpoint would have
   * had the verification link HMAC-signed and POSTed to it. The template says which channels it may
   * be delivered on, and this is the assertion that the restriction is applied rather than declared.
   */
  test('a notification carrying a single-use link is never sent to a developer webhook', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://developer.example.test/hooks/cf',
      secret: WEBHOOK_SECRET,
    })

    await ingestEvent(
      rig.deps,
      verification({ userId: ALICE, handle: 'alice', email: 'alice@cloudsforge.online', verifyUrl: VERIFY_LINK }),
    )
    await dispatchDue(rig.deps, 50)

    assert.equal(rig.adapters.webhook.sent.length, 0, 'a single-use link was posted to a third party')
    assert.equal(rig.adapters.email.sent.length, 1)
    const rows = await sql<Array<{ channel: string }>>`select channel from deliveries order by channel`
    assert.deepEqual(rows.map((row) => row.channel), ['email', 'in_app'])
  })

  /**
   * A digest preference must not swallow a single-use link.
   *
   * The trap is that every guard already in place stays quiet. `deliverOn` picks the right channel,
   * the address is on file so `reportUnaddressed` says nothing, the notification is written, the
   * routing is legal and the user gets a summary at nine the next morning. But `deliveriesFor` only
   * writes a delivery for an `instant` route, and `describe()` renders a batched item's SUBJECT —
   * 'Confirm your email address', which has no placeholders — so the link is never rendered
   * anywhere, and it is redacted out of `GET /notifications`. The account simply cannot be verified,
   * and nothing in the service reports a problem.
   */
  test('a single-use link is delivered now, whatever cadence the reader asked for', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, [
      { category: 'account', channel: 'email', enabled: true, digest: 'daily', minPriority: 'low' },
    ])

    await ingestEvent(
      rig.deps,
      verification({ userId: ALICE, handle: 'alice', email: 'alice@cloudsforge.online', verifyUrl: VERIFY_LINK }),
    )

    const batched = await sql<Array<{ n: number }>>`select count(*)::int as n from digests`
    assert.equal(batched[0]?.n, 0, 'a link that expires was put in a batch that fires tomorrow')

    await dispatchDue(rig.deps, 50)
    assert.equal(rig.adapters.email.sent[0]?.message.link, VERIFY_LINK)
  })

  /**
   * The address is stored against the user the PAYLOAD names, and never against the actor.
   *
   * `forUser` falls back to the envelope actor when the payload names nobody, which is right for
   * deciding who to tell and wrong for deciding whose address this is: a resend triggered by
   * somebody other than the account holder would durably re-point that person's email at an inbox
   * they do not own — including, from then on, every `critical` security alert about their money.
   * Notifying the wrong person once is a bad notification; storing the wrong address is a bad
   * notification for ever.
   */
  test('an address is kept only for the user the payload names, never for the actor', async () => {
    const rig = testRig(sql)

    const outcome = await ingestEvent(
      rig.deps,
      unregisteredEvent(
        'identity.email.verification_requested',
        BOB,
        // No userId, and BOB on the actor — the shape a resend from another principal would take.
        { handle: 'alice', email: 'alice@cloudsforge.online', verifyUrl: VERIFY_LINK },
        { actor: `user:${BOB}` },
      ),
    )
    assert.equal(outcome.kind, 'processed')

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from channel_targets`
    assert.equal(rows[0]?.n, 0, "somebody else's address was written onto this user")
  })

  /**
   * A rule that says it learns an address, given a payload with none.
   *
   * This is the producer-side regression: identity stops sending `email`, or a relay drops it. The
   * notification must still be written — the user can still see it in-app — but the absence has to
   * be countable, because otherwise it presents exactly as the defect this whole section repairs.
   */
  test('an event that should have carried an address and did not is counted, not swallowed', async () => {
    const rig = testRig(sql, { emailConfigured: true })

    const outcome = await ingestEvent(
      rig.deps,
      verification({ userId: ALICE, handle: 'alice', verifyUrl: VERIFY_LINK }),
    )
    assert.equal(outcome.kind, 'processed')

    const targets = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_targets where user_id = ${ALICE}
    `
    assert.equal(targets[0]?.n, 0, 'no address was carried, so none was invented')
    assert.equal(
      counterValue(rig.metrics, 'notify_failed_total', { channel: 'email', reason: 'no_address' }),
      1,
    )
  })
})
