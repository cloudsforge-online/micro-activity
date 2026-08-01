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
