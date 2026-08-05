/**
 * Ingest, against a real database.
 *
 * The test that carries the most weight is the first: **a redelivered event produces one record.**
 * Delivery is at-least-once by design (AD-10), so a redelivery is not an edge case, it is the
 * normal behaviour of a relay whose acknowledgement was lost. A feed that showed a user two
 * deposits for one deposit would be worse than a feed that showed none.
 *
 * The second is its mirror: an event on a topic this build has never heard of is **filed, not
 * dropped**. Losing an event silently is worse than filing it badly, because the event is gone
 * and nothing records that it ever arrived.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { signDelivery } from '@cloudsforge/contracts-events'
import {
  DeliverySignatureError,
  ingest,
  parseDelivery,
  verifySignature,
  type IngestDeps,
} from './ingest.ts'
import {
  ALICE,
  BOB,
  ROTATED_OUT_SECRET,
  SECRET,
  delivery,
  enabled,
  ingestDeps,
  migrateTestDb,
  openDb,
  quietLogger,
  resetActivity,
  skip,
  testMetrics,
  unknownTopicDelivery,
} from './testsupport.ts'
import type { Db } from './records.ts'

let sql: postgres.Sql
const db = () => sql as unknown as Db

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetActivity(sql)
})

/* ------------------------------------------------------------------ signatures */

test('an HMAC-invalid delivery is refused', () => {
  const { body } = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1' })
  const deps = ingestDeps(null as unknown as Db)

  // Signed with a secret this endpoint does not hold.
  const forged = signDelivery(body, 'a-completely-different-secret-32c')
  assert.throws(() => verifySignature(deps, body, forged), DeliverySignatureError)

  // A valid signature over a different body — the replay of a captured header onto new content.
  const valid = signDelivery(body, SECRET)
  assert.throws(() => verifySignature(deps, `${body} `, valid), DeliverySignatureError)

  // No signature at all.
  assert.throws(() => verifySignature(deps, body, undefined), DeliverySignatureError)
  // A header that is not a header.
  assert.throws(() => verifySignature(deps, body, 'sha256=deadbeef'), DeliverySignatureError)
})

test('a signature outside the freshness window is refused', () => {
  const { body } = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1' })
  const deps = ingestDeps(null as unknown as Db)
  // Six minutes old, against the five-minute default. A captured request must not be a lasting
  // credential; the relay's next attempt produces a fresh signature for free.
  const stale = signDelivery(body, SECRET, Date.now() - 360_000)
  assert.throws(() => verifySignature(deps, body, stale), (err: unknown) => {
    assert.ok(err instanceof DeliverySignatureError)
    assert.equal(err.reason, 'stale')
    return true
  })
})

test('a rotated-out secret is still accepted, so a rotation is a window and not an instant', () => {
  const { body } = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', secret: ROTATED_OUT_SECRET })
  const deps: IngestDeps = {
    sql: null as unknown as Db,
    logger: quietLogger(),
    metrics: testMetrics(),
    secrets: [SECRET, ROTATED_OUT_SECRET],
  }
  const signature = signDelivery(body, ROTATED_OUT_SECRET)
  verifySignature(deps, body, signature)
})

/* ------------------------------------------------------------------ dedupe */

test('THE RULE: a redelivered event produces one record', { skip }, async () => {
  const deps = ingestDeps(db())
  const first = delivery({
    topic: 'wallet.deposit.confirmed',
    key: 'wallet-1',
    payload: { userId: ALICE, amount: '10', assetCode: 'SHARD' },
  })

  const one = await ingest(deps, parseDelivery(first.body))
  assert.equal(one.status, 'recorded')

  // The same event, signed again — which is exactly what a relay does when its acknowledgement
  // was lost. Byte-for-byte the same body, and a fresh signature over it.
  const redelivered = parseDelivery(first.body)
  const two = await ingest(deps, redelivered)
  assert.equal(two.status, 'duplicate')

  const rows = await sql<{ n: number }[]>`select count(*)::int as n from activity_records`
  assert.equal(rows[0]?.n, 1)
  assert.match(deps.metrics.render(), /activity_duplicates_dropped_total 1/)
  assert.match(deps.metrics.render(), /activity_records_total\{category="deposit"\} 1/)
})

test('the unique constraint holds even if the inbox would not have caught it', { skip }, async () => {
  // The inbox is keyed on (topic, event_id) and the record on source_event_id alone. The same id
  // arriving under a different topic is a producer bug; the answer is still "we already have it",
  // not a 500 and a redelivery loop.
  const deps = ingestDeps(db())
  const first = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } })
  await ingest(deps, parseDelivery(first.body))

  const collision = delivery({
    topic: 'wallet.withdrawal.requested',
    key: 'w-1',
    payload: { userId: ALICE },
    id: first.envelope.id,
  })
  const outcome = await ingest(deps, parseDelivery(collision.body))
  assert.equal(outcome.status, 'duplicate')
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 1)
})

test('a handler that fails leaves no inbox row, so the redelivery is processed', { skip }, async () => {
  // "Record then handle" loses the event here: the inbox row would already exist and the
  // redelivery would be swallowed as a duplicate of work that never happened.
  const deps = ingestDeps(db())
  const { body, envelope } = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } })

  // An extra constraint that always fails, added beside the real ones and removed in `finally`.
  // A test that dropped a real constraint to break the insert would leave the schema without it
  // for every test that ran afterwards — the shared test database is not a fixture that resets.
  await sql`alter table activity_records add constraint tmp_always_fails check (false) not valid`
  try {
    await assert.rejects(() => ingest(deps, parseDelivery(body)))
  } finally {
    await sql`alter table activity_records drop constraint tmp_always_fails`
  }

  const inbox = await sql<{ n: number }[]>`
    select count(*)::int as n from inbox where event_id = ${envelope.id}
  `
  assert.equal(inbox[0]?.n, 0, 'a failed handler must not leave the event marked as seen')

  // And the redelivery goes through, which is the half that proves the event was not lost.
  const retry = await ingest(deps, parseDelivery(body))
  assert.equal(retry.status, 'recorded')
})

/* ------------------------------------------------------------------ quarantine */

test('THE RULE: an unknown topic is recorded as unclassified rather than dropped', { skip }, async () => {
  const deps = ingestDeps(db())
  const unknown = unknownTopicDelivery()
  const outcome = await ingest(deps, parseDelivery(unknown.body))

  assert.equal(outcome.status, 'recorded')
  if (outcome.status !== 'recorded') return
  assert.equal(outcome.record.category, 'unclassified')
  assert.equal(outcome.record.sourceTopic, 'worlds.session.ended')
  assert.equal(outcome.record.visibility, 'internal')

  // The payload is kept, so the row can be reclassified from data that was never thrown away.
  const stored = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from activity_records where id = ${outcome.record.id}
  `
  assert.deepEqual(stored[0]?.payload, { userId: ALICE })
  assert.match(deps.metrics.render(), /activity_records_total\{category="unclassified"\} 1/)
})

test('an unknown topic redelivered is still one record', { skip }, async () => {
  const deps = ingestDeps(db())
  const unknown = unknownTopicDelivery()
  await ingest(deps, parseDelivery(unknown.body))
  assert.equal((await ingest(deps, parseDelivery(unknown.body))).status, 'duplicate')
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 1)
})

/* ------------------------------------------------------------------ immutability and erasure */

test('a record is immutable: an update is refused by the database itself', { skip }, async () => {
  const deps = ingestDeps(db())
  const outcome = await ingest(
    deps,
    parseDelivery(delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } }).body),
  )
  assert.equal(outcome.status, 'recorded')
  if (outcome.status !== 'recorded') return

  await assert.rejects(
    () => sql`update activity_records set summary = 'something else' where id = ${outcome.record.id}`,
    /immutable/,
    'a feed entry that can be edited is a record of what somebody last said happened',
  )
})

test('identity.user.deleted erases that user and leaves everyone else alone', { skip }, async () => {
  const deps = ingestDeps(db())
  for (const user of [ALICE, ALICE, BOB]) {
    await ingest(
      deps,
      parseDelivery(delivery({ topic: 'wallet.deposit.confirmed', key: `w-${user}`, payload: { userId: user } }).body),
    )
  }
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 3)

  const erasure = delivery({ topic: 'identity.user.deleted', key: ALICE })
  const outcome = await ingest(deps, parseDelivery(erasure.body))
  assert.equal(outcome.status, 'erased')
  if (outcome.status !== 'erased') return
  assert.equal(outcome.removed, 2)

  const left = await sql<{ user_id: string }[]>`select user_id from activity_records`
  assert.deepEqual(left.map((row) => row.user_id), [BOB])
  // No tombstone. A feed entry keyed on the user id we were told to forget, in a feed nobody can
  // read, is personal data retained for no purpose. The inbox row is the acknowledgement.
  assert.equal(
    (await sql<{ n: number }[]>`select count(*)::int as n from inbox where topic = 'identity.user.deleted'`)[0]?.n,
    1,
  )
})

/* ------------------------------------------------------------------ lag */

test('ingest lag is measured from when the fact happened, not from when it was relayed', { skip }, async () => {
  const occurredAt = new Date('2026-07-30T12:00:00.000Z')
  const deps = ingestDeps(db(), { now: () => occurredAt.getTime() + 90_000 })
  await ingest(
    deps,
    parseDelivery(
      delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE }, occurredAt }).body,
    ),
  )
  const rendered = deps.metrics.render()
  // 90 seconds: above the 60s bucket, below the 300s one. A relay stuck for an hour is exactly
  // what this metric exists to show, so it has to be measured from `occurredAt`.
  assert.match(rendered, /activity_ingest_lag_seconds_bucket\{producer="wallet",le="60"\} 0/)
  assert.match(rendered, /activity_ingest_lag_seconds_bucket\{producer="wallet",le="300"\} 1/)
  assert.match(rendered, /activity_ingest_lag_seconds_sum\{producer="wallet"\} 90/)
})

/* ------------------------------------------------------------------ erasure, and what it missed */

test('THE RULE: erasure reaches a QUARANTINED row carrying the user, which it never used to', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE CASE THAT WAS BROKEN. `eraseUser` was `delete ... where user_id = $1`, so it erased every
  // row this service had successfully attributed and left behind every row where attribution had
  // FAILED — which is exactly the set nobody had ever looked at.
  //
  // An unknown topic is quarantined with `userId: null` on purpose (guessing an owner out of a
  // schema this build has never seen puts one person's event in another's feed), so a quarantined
  // row is simultaneously the row most likely to hold something personal and the row erasure could
  // not reach. Both were true at once, and this is the test that says so.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const deps = ingestDeps(db())

  // An unknown topic carrying Alice's id in its payload, and nothing else naming her.
  const quarantined = unknownTopicDelivery('worlds.session.ended', { player: ALICE, seats: 2 })
  const filed = await ingest(deps, parseDelivery(quarantined.body))
  assert.equal(filed.status, 'recorded')
  if (filed.status !== 'recorded') return
  assert.equal(filed.record.userId, null, 'the quarantine must still refuse to guess an owner')

  // One ordinary attributed row of Alice's, and one of Bob's that must survive.
  await ingest(deps, parseDelivery(
    delivery({ topic: 'wallet.deposit.confirmed', key: 'w-a', payload: { userId: ALICE } }).body,
  ))
  await ingest(deps, parseDelivery(
    delivery({ topic: 'wallet.deposit.confirmed', key: 'w-b', payload: { userId: BOB } }).body,
  ))
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 3)

  const outcome = await ingest(deps, parseDelivery(delivery({ topic: 'identity.user.deleted', key: ALICE }).body))
  assert.equal(outcome.status, 'erased')
  if (outcome.status !== 'erased') return
  // Two: the attributed row AND the quarantined one. Under the old code this was 1.
  assert.equal(outcome.removed, 2)

  // Nothing of Alice's remains anywhere in the table — not in a column, and not inside a payload.
  const left = await sql<{ user_id: string | null; payload: unknown }[]>`
    select user_id, payload from activity_records
  `
  assert.equal(left.length, 1, "only Bob's record may be left")
  assert.equal(left[0]?.user_id, BOB)
  assert.ok(!JSON.stringify(left).includes(ALICE), 'the erased user survived inside a payload')
})

test('erasure reaches a row where the id is only in the subject URN', { skip }, async () => {
  // The second hiding place. `subject_urn` is built from the ENVELOPE KEY, and every identity,
  // custody and billing topic is keyed by the user — so a quarantined `identity.*` topic puts the
  // user's id in that column and in no other. A payload scan alone would not find it.
  const deps = ingestDeps(db())
  const quarantined = unknownTopicDelivery('identity.profile.updated', { changed: 3 })
  const filed = await ingest(deps, parseDelivery(quarantined.body))
  assert.equal(filed.status, 'recorded')
  if (filed.status !== 'recorded') return
  assert.equal(filed.record.userId, null)
  assert.ok(filed.record.subjectUrn.endsWith(`:${ALICE}`), 'the key must be the last URN segment')
  assert.ok(!JSON.stringify(filed.record).includes('changed'))

  const outcome = await ingest(deps, parseDelivery(delivery({ topic: 'identity.user.deleted', key: ALICE }).body))
  assert.equal(outcome.status, 'erased')
  if (outcome.status !== 'erased') return
  assert.equal(outcome.removed, 1)
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 0)
})

test("erasure leaves an unowned operational record that names nobody", { skip }, async () => {
  // The other side of the widened WHERE, and the reason the two new clauses are scoped to
  // `user_id is null` AND to a match on the id itself: a reconciliation or a season opening has no
  // owner and must not be swept up by somebody else's erasure. `user_id IS NULL` is a normal,
  // populated state of this table, not a synonym for "orphaned personal data".
  const deps = ingestDeps(db())
  await ingest(deps, parseDelivery(
    delivery({ topic: 'ledger.reconciliation.completed', key: 'run-1', payload: { drift: '0' } }).body,
  ))
  const outcome = await ingest(deps, parseDelivery(delivery({ topic: 'identity.user.deleted', key: ALICE }).body))
  assert.equal(outcome.status, 'erased')
  if (outcome.status !== 'erased') return
  assert.equal(outcome.removed, 0)
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 1)
})

/* ------------------------------------------------------------------ the allowlist, end to end */

test('THE RULE: an email address and a live credential never reach the stored payload', { skip }, async () => {
  // The whole path, against a real column: parse, classify, redact, insert, read back. The unit
  // test proves the classifier drops them; this proves nothing downstream puts them back.
  const deps = ingestDeps(db())
  const sent = delivery({
    topic: 'identity.email.verification_requested',
    key: ALICE,
    payload: {
      userId: ALICE,
      handle: 'a-real-handle',
      email: 'someone@example.test',
      expiresAt: '2026-08-06T11:00:00.000Z',
      linkable: true,
      verifyUrl: 'https://hub.cloudsforge.online/verify?token=a-live-single-use-credential',
    },
  })
  const outcome = await ingest(deps, parseDelivery(sent.body))
  assert.equal(outcome.status, 'recorded')
  if (outcome.status !== 'recorded') return

  const stored = await sql<{ payload: Record<string, unknown>; summary: string }[]>`
    select payload, summary from activity_records where id = ${outcome.record.id}
  `
  assert.deepEqual(stored[0]?.payload, {
    linkable: true,
    __redacted: ['email', 'expiresAt', 'handle', 'userId', 'verifyUrl'],
  })
  const row = JSON.stringify(stored[0])
  assert.ok(!row.includes('someone@example.test'), 'the email address was stored')
  assert.ok(!row.includes('a-live-single-use-credential'), 'the credential was stored')

  // And the drop is counted, so a producer that starts sending a new field shows up on a dashboard
  // rather than in nobody's awareness at all.
  assert.match(
    deps.metrics.render(),
    /activity_payload_keys_dropped_total\{topic="identity\.email\.verification_requested"\} 5/,
  )
})
