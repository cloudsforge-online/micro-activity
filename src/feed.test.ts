/**
 * The feed: pagination, filters and visibility.
 *
 * The test that matters most is the pagination one. A feed is the single place `OFFSET` is
 * guaranteed to be wrong — records arrive continuously, so `OFFSET 2` means "skip two rows of
 * whatever the query returns *now*", and an event landing between page one and page two pushes
 * one entry onto the front of page two where the user sees it twice while another is never shown
 * at all. On a transaction history that is not a cosmetic bug, and it is the reason the cursor is
 * a keyset over `(occurred_at, id)` rather than a row count.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { ingest, parseDelivery } from './ingest.ts'
import { listAllRecords, listFeed } from './records.ts'
import {
  ALICE,
  BOB,
  delivery,
  enabled,
  ingestDeps,
  migrateTestDb,
  openDb,
  resetActivity,
  skip,
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

const BASE = Date.UTC(2026, 6, 30, 12, 0, 0)

/** One deposit for `user`, at `minute` minutes past the base instant. */
async function deposit(user: string, minute: number, amount = '1'): Promise<void> {
  await ingest(
    ingestDeps(db()),
    parseDelivery(
      delivery({
        topic: 'wallet.deposit.confirmed',
        key: `wallet-${user}`,
        payload: { userId: user, amount, assetCode: 'SHARD' },
        occurredAt: new Date(BASE + minute * 60_000),
      }).body,
    ),
  )
}

test('THE RULE: cursor pagination is stable when new records arrive mid-page', { skip }, async () => {
  for (const minute of [1, 2, 3, 4, 5]) await deposit(ALICE, minute)

  const first = await listFeed(db(), { userId: ALICE, limit: 2, includeInternal: false })
  assert.deepEqual(first.records.map((r) => r.amount && r.occurredAt), [
    new Date(BASE + 5 * 60_000).toISOString(),
    new Date(BASE + 4 * 60_000).toISOString(),
  ])
  assert.ok(first.nextCursor)

  // Three newer records arrive between the two page fetches. Under OFFSET, page two would repeat
  // minutes 4 and 5 and never show minute 3.
  for (const minute of [6, 7, 8]) await deposit(ALICE, minute)

  const second = await listFeed(db(), { userId: ALICE, limit: 2, includeInternal: false, cursor: first.nextCursor })
  assert.deepEqual(second.records.map((r) => r.occurredAt), [
    new Date(BASE + 3 * 60_000).toISOString(),
    new Date(BASE + 2 * 60_000).toISOString(),
  ])

  const third = await listFeed(db(), { userId: ALICE, limit: 2, includeInternal: false, cursor: second.nextCursor })
  assert.deepEqual(third.records.map((r) => r.occurredAt), [new Date(BASE + 1 * 60_000).toISOString()])
  assert.equal(third.nextCursor, undefined, 'the last page must not offer another')

  // Nothing was seen twice, and nothing was missed, across the whole walk.
  const walked = [...first.records, ...second.records, ...third.records].map((r) => r.id)
  assert.equal(new Set(walked).size, 5)
})

test('two records in the same millisecond both survive the cursor', { skip }, async () => {
  // A cursor on the timestamp alone would silently drop whichever of them sorted second, and the
  // symptom is one missing feed entry that nobody can reproduce.
  await deposit(ALICE, 1, '1')
  await deposit(ALICE, 1, '2')
  await deposit(ALICE, 1, '3')

  const first = await listFeed(db(), { userId: ALICE, limit: 2, includeInternal: false })
  const second = await listFeed(db(), { userId: ALICE, limit: 2, includeInternal: false, cursor: first.nextCursor })
  const walked = [...first.records, ...second.records].map((r) => r.id)
  assert.equal(walked.length, 3)
  assert.equal(new Set(walked).size, 3)
})

test('a feed is one user, and never leaks another', { skip }, async () => {
  await deposit(ALICE, 1)
  await deposit(BOB, 2)
  const alice = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false })
  assert.equal(alice.records.length, 1)
  assert.equal(alice.records[0]?.userId, ALICE)
})

test('a user is never shown an internal record, and an operator is', { skip }, async () => {
  await deposit(ALICE, 1)
  // A quarantined record has no owner and is internal, so it is in neither user feed — but an
  // operator can find it through the estate-wide query, which is how the backlog gets worked.
  await ingest(ingestDeps(db()), parseDelivery(unknownTopicDelivery().body))

  const user = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false })
  assert.deepEqual(user.records.map((r) => r.category), ['deposit'])

  const operator = await listAllRecords(db(), { limit: 10 })
  assert.deepEqual(operator.records.map((r) => r.category).sort(), ['deposit', 'unclassified'])

  const quarantine = await listAllRecords(db(), { limit: 10, category: 'unclassified' })
  assert.equal(quarantine.records.length, 1)
})

test('settlement\'s three, through the real ingest path, land where they belong', { skip }, async () => {
  // The end-to-end form of the classify tests, and the one that reads as the bug would have been
  // reported: a withdrawal id with a feed of its own, or a user with no entry for a payment that
  // failed. Everything here goes through `parseDelivery` -> `ingest` -> `listFeed`, so a
  // misattribution has to survive the whole pipe rather than one pure function.
  const deps = ingestDeps(db())
  const WITHDRAWAL = '66666666-6666-4666-8666-666666666666'
  const SWEEP_SOURCE = '77777777-7777-4777-8777-777777777777'
  const at = (minute: number) => new Date(BASE + minute * 60_000)
  const send = async (
    topic: Parameters<typeof delivery>[0]['topic'],
    key: string,
    payload: Record<string, unknown>,
    minute: number,
  ) => {
    await ingest(deps, parseDelivery(delivery({ topic, key, payload, occurredAt: at(minute) }).body))
  }

  // The pair `confirmedEvents` emits from ONE return statement for one row — both reach activity.
  //
  // **`userId` is on the narrow event ON PURPOSE, and settlement does not put it there today.**
  // This was written first with settlement's real payload — `{ withdrawalId, txHash }`, no user —
  // and that version of the test PASSED with the classifier deliberately broken to
  // `userFromPayload`, because a reader looking for a field that is absent returns null either way.
  // A guard that cannot fail. The shape sent here is the one settlement may reasonably adopt
  // tomorrow (the row has `userId` at settlement/src/outbound.ts:230, and the wide event already
  // carries it), which is exactly the day the double-post would appear; sending it now is what
  // makes `() => null` a tested refusal rather than a coincidence.
  await send(
    'settlement.outbound.confirmed',
    WITHDRAWAL,
    { withdrawalId: WITHDRAWAL, userId: ALICE, txHash: '0xaa' },
    1,
  )
  await send(
    'settlement.withdrawal.completed',
    WITHDRAWAL,
    { withdrawalId: WITHDRAWAL, userId: ALICE, amount: '25', assetCode: 'SHARD', transactionHash: '0xaa' },
    1,
  )
  // A failure that names its user, as settlement's payload will once `userId: row.userId` is added.
  await send(
    'settlement.outbound.failed',
    WITHDRAWAL,
    { withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'insufficient gas', refundable: true },
    2,
  )
  // A treasury sweep: real, recorded, and nobody's timeline entry.
  await send(
    'settlement.sweep.completed',
    SWEEP_SOURCE,
    { sweepSourceId: SWEEP_SOURCE, chain: 'ethereum', network: 'mainnet', assetCode: 'SHARD', amount: '1000' },
    3,
  )

  const alice = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false })
  // TWO entries, not three and not four: the payment that succeeded appears ONCE despite two
  // topics carrying it, and the failure appears with the type that says the money is coming back.
  assert.deepEqual(alice.records.map((r) => r.type), ['withdrawal.failed_refunded', 'withdrawal.completed'])

  // **The misattribution, stated as the symptom.** Every one of these four events is keyed by a
  // uuid that is not a user. If any classifier read its key, that id would now have a feed.
  const asWithdrawal = await listFeed(db(), { userId: WITHDRAWAL, limit: 10, includeInternal: true })
  assert.deepEqual(asWithdrawal.records, [], 'a withdrawal id must not have a feed')
  const asSweepSource = await listFeed(db(), { userId: SWEEP_SOURCE, limit: 10, includeInternal: true })
  assert.deepEqual(asSweepSource.records, [], 'a sweep source id must not have a feed')
  const bob = await listFeed(db(), { userId: BOB, limit: 10, includeInternal: true })
  assert.deepEqual(bob.records, [], 'no settlement event belongs to a bystander')

  // Nothing was dropped to achieve that. All four are stored; the two with no owner are the
  // operator's, which is where a reconciliation question gets answered.
  const operator = await listAllRecords(db(), { limit: 10 })
  assert.deepEqual(
    operator.records.map((r) => r.type).sort(),
    ['wallet.sweep_completed', 'withdrawal.completed', 'withdrawal.failed_refunded', 'withdrawal.outbound_confirmed'],
  )
})

test('the feed filters by category and by product', { skip }, async () => {
  const deps = ingestDeps(db())
  await deposit(ALICE, 1)
  await ingest(
    deps,
    parseDelivery(
      delivery({
        topic: 'billing.entitlement.granted',
        key: `user:${ALICE}`,
        payload: { scope: 'worlds:private' },
        occurredAt: new Date(BASE + 2 * 60_000),
      }).body,
    ),
  )
  await ingest(
    deps,
    parseDelivery(
      delivery({
        // Identity's REAL envelope: keyed by the SESSION id, user in the payload
        // (`identity/src/sessions.ts:198-205`). This fixture used to key by ALICE — a shape the
        // producer never sends — which is why the suite stayed green while every real sign-in
        // was attributed to its session id and appeared in nobody's feed.
        topic: 'identity.session.created',
        key: '9e1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
        payload: { sessionId: '9e1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', userId: ALICE, device: 'Firefox on macOS' },
        occurredAt: new Date(BASE + 3 * 60_000),
      }).body,
    ),
  )

  const all = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false })
  assert.equal(all.records.length, 3)

  const security = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false, category: 'security' })
  assert.deepEqual(security.records.map((r) => r.type), ['security.session_created'])

  // `product` is the producing service — the filter a "what has Forge Pay done for me" tab needs.
  const billing = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false, product: 'billing' })
  assert.deepEqual(billing.records.map((r) => r.category), ['billing'])

  const none = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false, category: 'trading' })
  assert.equal(none.records.length, 0)
})

test('the amount is stored exactly as the producer wrote it', { skip }, async () => {
  // numeric(40,18) would return "10.000000000000000000" for a deposit of 10, and a feed that
  // reformats a user's money is a feed they do not trust.
  await deposit(ALICE, 1, '10')
  await deposit(ALICE, 2, '0.000000000000000001')
  const page = await listFeed(db(), { userId: ALICE, limit: 10, includeInternal: false })
  assert.deepEqual(page.records.map((r) => r.amount), ['0.000000000000000001', '10'])
})
