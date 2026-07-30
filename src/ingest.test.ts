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
