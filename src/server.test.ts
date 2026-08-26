/**
 * The HTTP surface.
 *
 * The auth-fault mapping is copied from the template and tested again here rather than assumed,
 * because it is the decision most easily got backwards: an unreachable JWKS is **503**, never 401.
 *
 * The route-level tests are the two halves of this module's event-bus inbox. A **service token**
 * says who is calling; a **delivery signature** says the body was not altered between the
 * producer's outbox and this handler. Neither implies the other, and the signature is the one
 * that is required — see the route's own note.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PATH IS `ACTIVITY_INGEST_PATH`, NOT `/ingest`, SINCE WAVE M2.** Named rather than typed,
 * so this suite and the route cannot disagree about it — and because the bare `/ingest` is now a
 * route in its own right that answers 410, which a literal here would silently start driving.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { SignJWT, generateKeyPair } from 'jose'
import { SIGNATURE_HEADER, signDelivery } from '@cloudsforge/contracts-events'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { ACTIVITY_INGEST_PATH, INGEST_PATHS, createServer } from './server.ts'
import {
  ALICE,
  BOB,
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

const ISSUER = 'https://identity.test'

const keys = await generateKeyPair('RS256', { extractable: true })

const sign = (payload: Record<string, unknown>) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(keys.privateKey)

/** A real `Verifier` over a local key set. Nothing here stubs the decision under test. */
const workingVerifier = () =>
  new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet: (async () => keys.publicKey) as never })

/** A real `Verifier` whose JWKS cannot be reached. */
const unreachableVerifier = () =>
  new Verifier({
    jwksUrl: 'http://down',
    issuer: ISSUER,
    keySet: (async () => {
      throw new Error('getaddrinfo EAI_AGAIN identity')
    }) as never,
  })

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

async function withServer(
  options: { verifier?: Verifier } = {},
  fn: (h: { url: string }) => Promise<void>,
): Promise<void> {
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  const metrics = testMetrics()
  const server: Server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics,
    verifier: options.verifier ?? workingVerifier(),
    sql: singleNetworkSql(db()),
    singleNetwork: 'mainnet' as const,
    ingest: { ...ingestDeps(db()), metrics, logger: quietLogger() },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  lifecycle.markReady()
  const { port } = server.address() as AddressInfo
  try {
    await fn({ url: `http://127.0.0.1:${port}` })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const relay = () => sign({ sub: 'service:wallet', scopes: [] })
const alice = () => sign({ sub: ALICE, handle: 'alice', roles: ['player'] })
const bob = () => sign({ sub: BOB, handle: 'bob', roles: ['player'] })
const operator = () => sign({ sub: 'u-ops', handle: 'ops', roles: ['admin'] })

const post = (url: string, token: string, body: string, signature: string) =>
  fetch(`${url}${ACTIVITY_INGEST_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signature,
    },
    body,
  })

/* ------------------------------------------------------------------ health */

test('livez is static and readyz reports real state', { skip }, async () => {
  await withServer({}, async (h) => {
    assert.equal((await fetch(`${h.url}/livez`)).status, 200)
    const ready = await fetch(`${h.url}/readyz`)
    assert.equal(ready.status, 200)
    assert.equal(ready.headers.get('cache-control'), 'no-store')
  })
})

test('metrics render as valid Prometheus exposition', { skip }, async () => {
  await withServer({}, async (h) => {
    const one = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE, amount: '5', assetCode: 'SHARD' } })
    await post(h.url, await relay(), one.body, one.signature)

    const res = await fetch(`${h.url}/metrics`)
    assert.equal(res.status, 200)
    const text = await res.text()
    const comment = /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+$/
    const sample =
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*\})? -?(\d+(\.\d+)?([eE][-+]?\d+)?|\+Inf|NaN)$/
    for (const line of text.split('\n').filter((l) => l.length > 0)) {
      assert.ok(comment.test(line) || sample.test(line), `not valid exposition: ${line}`)
    }
    assert.match(text, /activity_records_total\{category="deposit"\} 1/)
  })
})

/* ------------------------------------------------------------------ ingest */

test('THE RULE: ingesting the same event twice leaves one record in the feed', { skip }, async () => {
  await withServer({}, async (h) => {
    const token = await relay()
    const event = delivery({
      topic: 'wallet.deposit.confirmed',
      key: 'wallet-1',
      // 25 SHARD as wallet sends it (`wallet/src/deposits.ts`): the raw smallest units
      // AND the decimal figure only wallet can compute. The assertion below is on the summary the
      // user reads, and since micro-org#199 that sentence is built from the formatted half.
      payload: { userId: ALICE, amount: '25000000000000000000', amountFormatted: '25', assetCode: 'SHARD' },
    })

    const first = await post(h.url, token, event.body, event.signature)
    assert.equal(first.status, 201)
    assert.equal(((await first.json()) as { status: string }).status, 'recorded')

    // The same bytes, signed again — exactly what a relay does when its acknowledgement was lost.
    const second = await post(h.url, token, event.body, signDelivery(event.body, SECRET))
    // 200, not 409: a redelivery is the producer doing what at-least-once delivery requires, and
    // an error status would make the relay retry for ever.
    assert.equal(second.status, 200)
    assert.equal(((await second.json()) as { status: string }).status, 'duplicate')

    const feed = await fetch(`${h.url}/feed`, { headers: { authorization: `Bearer ${await alice()}` } })
    assert.equal(feed.status, 200)
    const body = (await feed.json()) as { records: { id: string; summary: string }[] }
    assert.equal(body.records.length, 1)
    assert.match(body.records[0]?.summary ?? '', /25 SHARD/)
  })
})

test('THE RULE: an HMAC-invalid delivery is refused and writes nothing', { skip }, async () => {
  await withServer({}, async (h) => {
    const token = await relay()
    const event = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } })

    const forged = await post(h.url, token, event.body, signDelivery(event.body, 'not-the-right-secret-at-all-32'))
    assert.equal(forged.status, 401)
    // The reason is logged, never returned: telling a caller whether their signature was stale or
    // simply wrong tells a forger which half to fix.
    const body = (await forged.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'bad_signature')
    assert.equal(/stale|mismatch|key/i.test(body.error.message), false, body.error.message)

    // A valid signature over different bytes: the replay of a captured header onto new content.
    const tampered = event.body.replace('"key"', '"KEY"')
    assert.equal((await post(h.url, token, tampered, event.signature)).status, 401)

    // No signature at all.
    const unsigned = await fetch(`${h.url}${ACTIVITY_INGEST_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: event.body,
    })
    assert.equal(unsigned.status, 401)

    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 0)
  })
})

test('no token of any kind writes to the feed — only a signature does, and a token is not one', { skip }, async () => {
  // AD-11 held STRONGER than before. The old form authenticated first and demanded a service
  // principal — which no outbox relay in the estate presents, so the event bus itself was 401'd
  // by the route built to receive it. Now the MAC over the raw bytes is the only gate: a user or
  // operator token on a correctly SIGNED delivery is ignored rather than honoured, and the same
  // tokens without a signature create nothing. There is no code path from any token to a record.
  await withServer({}, async (h) => {
    const event = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } })
    // Signed correctly, token irrelevant: the delivery lands because of the MAC, not the bearer.
    const signed = await post(h.url, await alice(), event.body, event.signature)
    assert.equal(signed.status, 201, 'a fresh record; 200 is the duplicate case')
    // Unsigned, with the most privileged tokens the estate mints: refused, nothing written.
    for (const token of [await alice(), await operator()]) {
      const res = await fetch(`${h.url}${ACTIVITY_INGEST_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: event.body,
      })
      assert.equal(res.status, 401)
    }
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 1)
  })
})

test('an unsigned ingest is 401 before the body is even parsed', { skip }, async () => {
  // Unparseable garbage with no signature: refused by the MAC check, which never parses.
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}${ACTIVITY_INGEST_PATH}`, { method: 'POST', body: '{not json' })
    assert.equal(res.status, 401)
  })
})

test('ingest survives an unreachable JWKS, because the bus must not die when identity blinks', { skip }, async () => {
  // The old assertion here was 503-not-401, which was the right rule for a route that consulted
  // the verifier. This route no longer consults it at all — the MAC is the authentication — and
  // that is a resilience property worth pinning: an identity outage used to take the whole event
  // bus down with it, since every delivery 503'd at the verifier before its signature was read.
  const event = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } })
  await withServer({ verifier: unreachableVerifier() }, async (h) => {
    const res = await post(h.url, await relay(), event.body, event.signature)
    assert.equal(res.status, 201, 'a fresh record lands while identity is down')
  })
})

test('a malformed envelope is 400 with every problem at once', { skip }, async () => {
  await withServer({}, async (h) => {
    const body = JSON.stringify({ topic: 'wallet.deposit.confirmed', id: 'nope' })
    const res = await post(h.url, await relay(), body, signDelivery(body, SECRET))
    assert.equal(res.status, 400)
    const message = ((await res.json()) as { error: { message: string } }).error.message
    // One round trip to fix, not five. The caller here is another service in the estate.
    assert.match(message, /id/)
    assert.match(message, /key/)
    assert.match(message, /correlationId/)
  })
})

test('an unknown topic with an ILLEGAL ACTOR is 400, not quarantined', { skip }, async () => {
  // This used to be a 201 and a stored row. Quarantine forgives one fact — that this build's
  // registry is behind its producers — and it never forgave a malformed envelope; the shorter
  // checklist it ran just failed to look. `key:<display>` is the spelling devplatform really
  // shipped, and it was invisible for exactly as long as its topic was unregistered here.
  await withServer({}, async (h) => {
    const bad = unknownTopicDelivery('worlds.session.ended', { userId: ALICE }, { actor: 'key:cfk_live_abcd1234' })
    const res = await post(h.url, await relay(), bad.body, bad.signature)
    assert.equal(res.status, 400, 'an illegal actor must reach its producer as a producer bug')
    const message = ((await res.json()) as { error: { message: string } }).error.message
    assert.match(message, /actor/)
    // And NOT "not in this registry": being behind a producer is never the caller's fault, and
    // naming it would send devplatform to go and fix a contracts release it does not own.
    assert.doesNotMatch(message, /not in this registry/)

    // Refused, so nothing was written — and the operator's backlog is not polluted with a row
    // that reads as "activity is behind" when the truth is "the producer is wrong".
    const operatorFeed = await fetch(`${h.url}/feed?category=unclassified`, {
      headers: { authorization: `Bearer ${await operator()}` },
    })
    assert.equal(((await operatorFeed.json()) as { records: unknown[] }).records.length, 0)
  })
})

test('an unknown topic is accepted and quarantined, and stays out of a user feed', { skip }, async () => {
  await withServer({}, async (h) => {
    const unknown = unknownTopicDelivery()
    const res = await post(h.url, await relay(), unknown.body, unknown.signature)
    assert.equal(res.status, 201)
    const { record } = (await res.json()) as { record: { category: string; visibility: string } }
    assert.equal(record.category, 'unclassified')

    const userFeed = await fetch(`${h.url}/feed`, { headers: { authorization: `Bearer ${await alice()}` } })
    assert.equal(((await userFeed.json()) as { records: unknown[] }).records.length, 0)

    // An operator can see it. That query is the backlog of topics this build predates.
    const operatorFeed = await fetch(`${h.url}/feed?category=unclassified`, {
      headers: { authorization: `Bearer ${await operator()}` },
    })
    assert.equal(((await operatorFeed.json()) as { records: unknown[] }).records.length, 1)

    // And a user may not even ask for that category: it is not part of the product's vocabulary.
    const refused = await fetch(`${h.url}/feed?category=unclassified`, {
      headers: { authorization: `Bearer ${await alice()}` },
    })
    assert.equal(refused.status, 400)
  })
})

/* ------------------------------------------------------------------ feed */

test('a user reads their own feed and nobody else reads it', { skip }, async () => {
  await withServer({}, async (h) => {
    const token = await relay()
    const event = delivery({
      topic: 'wallet.deposit.confirmed',
      key: 'w-1',
      payload: { userId: ALICE, amount: '1', assetCode: 'SHARD' },
    })
    const created = await post(h.url, token, event.body, event.signature)
    const { record } = (await created.json()) as { record: { id: string } }

    const mine = await fetch(`${h.url}/feed/${record.id}`, { headers: { authorization: `Bearer ${await alice()}` } })
    assert.equal(mine.status, 200)

    const theirs = await fetch(`${h.url}/feed/${record.id}`, { headers: { authorization: `Bearer ${await bob()}` } })
    assert.equal(theirs.status, 403)

    // Asking for another user's feed by parameter is refused too, not silently answered with
    // one's own — a filter that quietly rewrote the request would hide the attempt.
    const byParam = await fetch(`${h.url}/feed?userId=${BOB}`, {
      headers: { authorization: `Bearer ${await alice()}` },
    })
    assert.equal(byParam.status, 403)

    const asOperator = await fetch(`${h.url}/feed?userId=${ALICE}`, {
      headers: { authorization: `Bearer ${await operator()}` },
    })
    assert.equal(asOperator.status, 200)
    assert.equal(((await asOperator.json()) as { records: unknown[] }).records.length, 1)
  })
})

test('the feed pages by cursor over HTTP, and the cursor is opaque', { skip }, async () => {
  await withServer({}, async (h) => {
    const token = await relay()
    for (let minute = 1; minute <= 3; minute += 1) {
      const event = delivery({
        topic: 'wallet.deposit.confirmed',
        key: `w-${minute}`,
        // The pair wallet emits (`wallet/src/deposits.ts`). The assertions below are on
        // the ORDER of the page rather than on the figures, but they read the `amount` column to
        // do it, and since micro-org#199 that column is filled from the formatted half — a bare
        // decimal `amount` from a smallest-units producer would land as null and assert nothing.
        payload: {
          userId: ALICE,
          amount: `${minute}000000000000000000`,
          amountFormatted: String(minute),
          assetCode: 'SHARD',
        },
        occurredAt: new Date(Date.UTC(2026, 6, 30, 12, minute, 0)),
      })
      await post(h.url, token, event.body, event.signature)
    }

    const auth = { authorization: `Bearer ${await alice()}` }
    const first = await (await fetch(`${h.url}/feed?limit=2`, { headers: auth })).json() as {
      records: { amount: string }[]
      nextCursor?: string
    }
    assert.deepEqual(first.records.map((r) => r.amount), ['3', '2'])
    assert.ok(first.nextCursor)

    const second = await (await fetch(`${h.url}/feed?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, {
      headers: auth,
    })).json() as { records: { amount: string }[]; nextCursor?: string }
    assert.deepEqual(second.records.map((r) => r.amount), ['1'])
    assert.equal(second.nextCursor, undefined)

    const forged = await fetch(`${h.url}/feed?cursor=bm90LWEtY3Vyc29y`, { headers: auth })
    assert.equal(forged.status, 400)
  })
})

test('the retired shared /ingest answers 410 and names both successors', { skip }, async () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * WAVE M2's ONE BREAKING CHANGE, PINNED WHERE A PRODUCER WOULD MEET IT.
   *
   * Both merged modules mounted `POST /ingest` and they verify it with DIFFERENT secrets, so one
   * mount cannot serve it honestly. Every alternative to this 410 fails silently in a direction
   * somebody then has to diagnose: aliasing it to this module answers 401 `bad_signature` to every
   * notify producer, which reads as a rotated or broken secret — the single most expensive
   * misdiagnosis this estate makes — and an outbox relay retries a 401 for ever.
   *
   * So the assertions are about DIAGNOSABILITY, not merely about the status: the body must name
   * both replacement paths, and the refusal must not depend on a signature. A 410 that only fired
   * for correctly-signed bodies would be an oracle for which secret signed a given payload, and
   * would answer 401 to exactly the producers that most need to read it.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  await withServer({}, async (h) => {
    const event = delivery({ topic: 'wallet.deposit.confirmed', key: 'w-1', payload: { userId: ALICE } })
    for (const [label, res] of [
      [
        'a correctly signed body',
        await fetch(`${h.url}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: event.signature },
          body: event.body,
        }),
      ] as const,
      [
        'an unsigned one',
        await fetch(`${h.url}/ingest`, { method: 'POST', body: '{not json' }),
      ] as const,
    ]) {
      assert.equal(res.status, 410, `${label} must get the same answer`)
      const body = (await res.json()) as { error: { code: string; message: string; served: string[] } }
      assert.equal(body.error.code, 'ingest_path_split')
      assert.deepEqual(body.error.served, [...INGEST_PATHS])
      // The message has to carry the fix, because the caller reading it is a background relay
      // whose only other output is a retry.
      assert.match(body.error.message, /\/ingest\/activity/)
      assert.match(body.error.message, /\/ingest\/notify/)
    }
    // And it wrote nothing on the way past. A signed body reaching a 410 must not also be ingested.
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from activity_records`)[0]?.n, 0)
  })
})

test('an unknown path is 404 and does not mint a metric series of its own', { skip }, async () => {
  await withServer({}, async (h) => {
    assert.equal((await fetch(`${h.url}/v1/nothing-here`)).status, 404)
    const scrape = await (await fetch(`${h.url}/metrics`)).text()
    assert.match(scrape, /route="unmatched"/)
    assert.equal(/nothing-here/.test(scrape), false)
  })
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
