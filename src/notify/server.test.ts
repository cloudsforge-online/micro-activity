/**
 * The routes.
 *
 * No database and no JWKS: the store is a fake behind `NotifyStore` and the verifier is a
 * function. That is why this file runs in CI without a Postgres service, and it is why a change
 * to a route's authorisation is caught in milliseconds rather than in a database test.
 *
 * The tests that matter most here are the ingest ones — `NOTIFY_INGEST_PATH`, which was `/ingest`
 * until wave M2 gave each merged module an inbox of its own. That endpoint mints notifications on
 * behalf of the rest of the estate, so it is authenticated twice — a service token *and* an HMAC
 * over the raw body — and each half is tested for being genuinely required.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { signDelivery } from '@cloudsforge/contracts-events'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { NOTIFY_INGEST_PATH, READ_SCOPE, createServer, type ServerDeps } from './server.ts'
import { SIGNATURE_HEADER } from './events.ts'
import { registryOf } from './channels.ts'
import type { Notification, NotifyStore } from './store.ts'
import type { PipelineDeps } from './pipeline.ts'
import { ALICE, BOB, registeredEvent, testLogger, testMetrics } from './testsupport.ts'

const INGEST_SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'

/**
 * The handle behind this suite's selector. Every property access throws.
 *
 * `ctx.sql` is resolved at the edge of every request by the shared kernel, so it is resolved on
 * requests this suite makes — but no route here is supposed to USE it. A stub that answered
 * plausibly would let a handler start reading the database and this suite would keep passing.
 */
const UNREACHABLE_DB = new Proxy({} as never, {
  get() {
    throw new Error('the route suite must not reach the database')
  },
}) as unknown as RuntimeSql

const USER: Principal = { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
const ADMIN: Principal = { kind: 'user', userId: BOB, handle: 'root', roles: ['admin'] }
const SERVICE: Principal = { kind: 'service', service: 'custody', scopes: [READ_SCOPE] }
const UNSCOPED: Principal = { kind: 'service', service: 'market', scopes: [] }

interface Harness {
  readonly url: string
  readonly calls: {
    broadcasts: string[]
    dispatches: number
    preferences: Array<{ userId: string; count: number }>
    ingested: number
  }
  close(): Promise<void>
}

function fakeStore(calls: Harness['calls']): NotifyStore {
  return {
    async listNotifications(userId, options) {
      const rows: Notification[] = [
        {
          id: '55555555-5555-4555-8555-555555555555',
          userId,
          category: 'security',
          priority: 'critical',
          templateId: 'security.key_exported',
          params: {},
          locale: 'en-GB',
          dedupeKey: 'security.key_exported:k1',
          subjectUrn: null,
          channelCount: 1,
          suppressedReason: null,
          createdAt: new Date().toISOString(),
          readAt: null,
        },
      ]
      return { notifications: rows.slice(0, options.limit), nextCursor: null, unread: 1 }
    },
    async markRead(userId, id): Promise<Notification | null> {
      if (id !== '55555555-5555-4555-8555-555555555555') return null
      return {
        id,
        userId,
        category: 'security',
        priority: 'critical',
        templateId: 'security.key_exported',
        params: {},
        locale: 'en-GB',
        dedupeKey: null,
        subjectUrn: null,
        channelCount: 1,
        suppressedReason: null,
        createdAt: new Date().toISOString(),
        readAt: new Date().toISOString(),
      }
    },
    async listPreferences() {
      return [
        {
          category: 'market' as const,
          channel: 'email' as const,
          enabled: false,
          digest: 'off' as const,
          minPriority: 'low' as const,
        },
      ]
    },
    async upsertPreferences(userId, preferences) {
      calls.preferences.push({ userId, count: preferences.length })
      return [...preferences]
    },
    async insertBroadcast(input) {
      return {
        id: '66666666-6666-4666-8666-666666666666',
        category: input.category,
        priority: input.priority,
        templateId: input.templateId,
        params: input.params,
        audience: input.audience,
        userIds: input.userIds,
        dedupeKey: input.dedupeKey,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
        recipients: null,
      }
    },
    async resendDelivery(id: string) {
      return id === '77777777-7777-4777-8777-777777777777'
        ? '88888888-8888-4888-8888-888888888888'
        : null
    },
    async listDeliveries(options) {
      return {
        deliveries: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            notificationId: '55555555-5555-4555-8555-555555555555',
            userId: ALICE,
            channel: options.channel ?? 'email',
            state: 'undeliverable' as const,
            outcome: 'undeliverable_no_transport',
            reason: 'no_transport' as const,
            attempts: 1,
            maxAttempts: 6,
            lastError: 'SMTP_HOST or SMTP_FROM is not set; no mail is sent',
            category: 'security' as const,
            priority: 'critical' as const,
            templateId: 'security.key_exported',
            createdAt: new Date().toISOString(),
            nextAttemptAt: new Date().toISOString(),
            sentAt: null,
          },
        ],
        nextCursor: null,
      }
    },
  }
}

async function harness(principal: Principal | Error = USER): Promise<Harness> {
  const calls: Harness['calls'] = { broadcasts: [], dispatches: 0, preferences: [], ingested: 0 }
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
  lifecycle.markReady()

  const pipeline: PipelineDeps = {
    // The ingest route is tested for what it accepts and rejects, not for what the pipeline then
    // does with it — that is `pipeline.test.ts`, against a real database. So the `sql` here is
    // never reached: a rejected request never gets that far, and the accepted one is counted by
    // a store fake standing in for the whole pipeline.
    sql: new Proxy({} as never, {
      get() {
        throw new Error('the route suite must not reach the database')
      },
    }),
    logger: testLogger(),
    metrics: testMetrics(),
    adapters: registryOf([]),
    publicUrl: 'https://app.cloudsforge.test',
    maxAttempts: 6,
    instanceId: 'test',
    // Never read here: nothing in this suite creates a notification, which is the only place it is
    // consulted. Present because `PipelineDeps` requires it, and it requires it because a composition
    // root that forgot it would silently switch off the signal that says mail reaches nobody.
    emailConfigured: false,
  }

  const deps: ServerDeps = {
    lifecycle,
    logger: testLogger(),
    metrics: testMetrics(),
    verifier: {
      async principal() {
        if (principal instanceof Error) throw principal
        return principal
      },
    },
    store: fakeStore(calls),
    pipeline,
    // ── THE SELECTOR ARRIVED WITH WAVE M2, AND IT ANSWERS BOTH NETWORKS WITH ONE HANDLE ────────
    //
    // notify is a class B′ singleton: one database, and the estate is a COLUMN on the delivery.
    // The shared kernel resolves `ctx.sql` from whatever selector the route names, so this module
    // names one that says the same thing its production selector says — see
    // `module.ts`'s `notifySql`. Registering only `mainnet` here would make every testnet request
    // a 500 `network_unavailable`, which is right for activity and a regression for this module.
    //
    // The handle behind it throws on use, for the same reason the pipeline's does: no route in
    // this suite reaches the database, and one that started to must fail loudly rather than
    // quietly find nothing.
    sql: networkSql({ mainnet: UNREACHABLE_DB, testnet: UNREACHABLE_DB }),
    // The harness talks to the server directly, with no gateway to stamp `CF-Network`. Same
    // position as `pnpm dev`, and the same setting covers it — a route that reached this far
    // without a network would answer 500, which is deliberate everywhere else.
    singleNetwork: 'mainnet' as const,
    ingestSecrets: [INGEST_SECRET],
    enqueueBroadcast: async (id) => {
      calls.broadcasts.push(id)
    },
    enqueueDispatch: async () => {
      calls.dispatches += 1
    },
  }

  const server = createServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const open: Harness[] = []
async function start(principal?: Principal | Error): Promise<Harness> {
  const rig = await harness(principal)
  open.push(rig)
  return rig
}
after(async () => {
  for (const rig of open) await rig.close()
})

/* ------------------------------------------------------------------ health */

test('the three mandated endpoints answer', async () => {
  const rig = await start()
  for (const path of ['/livez', '/readyz']) {
    const response = await fetch(`${rig.url}${path}`)
    assert.equal(response.status, 200, path)
  }
  const metrics = await fetch(`${rig.url}/metrics`)
  assert.equal(metrics.status, 200)
  const body = await metrics.text()
  assert.match(body, /notify_sent_total/)
  assert.match(body, /notify_failed_total/)
  assert.match(body, /notify_delivery_latency_ms/)
  assert.match(body, /notify_deadletter_total/)
  assert.match(body, /notify_suppressed_total/)
})

test('an unknown path is a 404 carrying the request id', async () => {
  const rig = await start()
  const response = await fetch(`${rig.url}/nope`, { headers: { 'x-request-id': 'abc123' } })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('x-request-id'), 'abc123')
  const body = (await response.json()) as { error: { requestId: string } }
  assert.equal(body.error.requestId, 'abc123')
})

test('a request id that is not safe to log or echo is replaced', async () => {
  const rig = await start()
  // Spaces and quotes are legal in a header value and illegal in a metric label and a JSON log
  // field. An unvalidated value here is a log-forgery and header-injection primitive at once, so
  // anything outside the safe alphabet is replaced rather than rejected — the caller does not
  // need a 400 over this.
  const hostile = 'id" route="/livez'
  const response = await fetch(`${rig.url}/livez`, { headers: { 'x-request-id': hostile } })
  assert.equal(response.status, 200)
  assert.notEqual(response.headers.get('x-request-id'), hostile)
  assert.match(response.headers.get('x-request-id') ?? '', /^[A-Za-z0-9_-]{1,64}$/)
})

/* ------------------------------------------------------------------ auth */

test('a missing token is 401 and a verifier outage is 503, never 401', async () => {
  const anonymous = await start(new TokenError('none', 'missing'))
  assert.equal((await fetch(`${anonymous.url}/notifications`)).status, 401)

  const down = await start(new VerifierUnavailableError('jwks unreachable'))
  const response = await fetch(`${down.url}/notifications`, {
    headers: { authorization: 'Bearer t' },
  })
  // 401 here would sign every user in the estate out because identity had a bad minute.
  assert.equal(response.status, 503)
})

test('a user cannot read another user notifications', async () => {
  const rig = await start()
  const response = await fetch(`${rig.url}/notifications?userId=${BOB}`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 403)
})

test('an admin can read another user notifications', async () => {
  const rig = await start(ADMIN)
  const response = await fetch(`${rig.url}/notifications?userId=${ALICE}`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { notifications: unknown[]; unread: number }
  assert.equal(body.notifications.length, 1)
  assert.equal(body.unread, 1)
})

test('a service token without the read scope is refused', async () => {
  const rig = await start(UNSCOPED)
  const response = await fetch(`${rig.url}/notifications?userId=${ALICE}`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 403)
})

/* ------------------------------------------------------------------ notifications */

test('marking a notification read returns it; someone elses is a 404, not a 403', async () => {
  const rig = await start()
  const ok = await fetch(`${rig.url}/notifications/55555555-5555-4555-8555-555555555555/read`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(ok.status, 200)

  // 403 would confirm that the id exists. The scoping is in the WHERE clause, so the route cannot
  // tell "not yours" from "not there" — and it must not.
  const missing = await fetch(`${rig.url}/notifications/99999999-9999-4999-8999-999999999999/read`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(missing.status, 404)
})

test('a notification is served with the words a screen needs, not just a template id', async () => {
  // The read route used to answer with `templateId` and a parameter bag and nothing else, so any
  // screen drawing a notification had to hold its own copy of the estate's sentences. hub-api now
  // composes a `notifications` tile for every signed-in Overview (micro-org #415) and renders
  // `title` verbatim, so the absence of this field is the absence of the feature.
  const rig = await start()
  const response = await fetch(`${rig.url}/notifications`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    notifications: { templateId: string; title: string; href: string | null }[]
  }
  const first = body.notifications[0]
  assert.equal(first?.title, 'A private key left the platform')
  assert.equal(first?.href, '/settings/security/exports')
  // Additive: every field the old response carried is still there, under the same name.
  assert.equal(first?.templateId, 'security.key_exported')

  // The same mapper on both read routes. Two mappers is one mapper away from a route that answers
  // with a different shape, and the one that drifts is always the one nobody looks at.
  const read = await fetch(`${rig.url}/notifications/55555555-5555-4555-8555-555555555555/read`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
  })
  const marked = (await read.json()) as { notification: { title: string; href: string | null } }
  assert.equal(marked.notification.title, 'A private key left the platform')
  assert.equal(marked.notification.href, '/settings/security/exports')
})

test('an out-of-range limit is a 400', async () => {
  const rig = await start()
  const response = await fetch(`${rig.url}/notifications?limit=1000`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 400)
})

/* ------------------------------------------------------------------ preferences */

test('preferences are returned with the categories and the critical exception stated', async () => {
  const rig = await start()
  const response = await fetch(`${rig.url}/preferences`, { headers: { authorization: 'Bearer t' } })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    categories: string[]
    alwaysDelivered: { priority: string; note: string }
  }
  assert.ok(body.categories.includes('security'))
  assert.equal(body.alwaysDelivered.priority, 'critical')
  // FEA-41: the unsubscribe path must say so. A client deriving this itself would be a second
  // copy of §10.3 that can disagree with the one that is enforced.
  assert.match(body.alwaysDelivered.note, /cannot be switched off/)
})

test('preferences are validated against the closed sets', async () => {
  const rig = await start()
  const put = (preferences: unknown) =>
    fetch(`${rig.url}/preferences`, {
      method: 'PUT',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ preferences }),
    })

  assert.equal((await put([{ category: 'nope', channel: 'email' }])).status, 400)
  assert.equal((await put([{ category: 'market', channel: 'carrier_pigeon' }])).status, 400)
  assert.equal((await put([{ category: 'market', channel: 'email', digest: 'weekly' }])).status, 400)
  assert.equal((await put('not an array')).status, 400)

  const ok = await put([{ category: 'market', channel: 'email', enabled: false, digest: 'off' }])
  assert.equal(ok.status, 200)
  assert.deepEqual(rig.calls.preferences, [{ userId: ALICE, count: 1 }])
})

/* ------------------------------------------------------------------ ingest */

function signed(body: string): Record<string, string> {
  return {
    authorization: 'Bearer service-token',
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: signDelivery(body, INGEST_SECRET),
  }
}

test('a signed delivery lands whatever token rides along, because the MAC is the gate', async () => {
  // These two tests used to demand a service token and the ingest scope — a demand no producer
  // in the estate could meet, since every outbox relay sends the signature and NO bearer. The
  // route the event bus exists to call refused the event bus. The property that mattered — a
  // signed-in person cannot mint notifications — holds stronger now: a person does not hold the
  // outbox signing secret, and no token of any kind is read.
  // The envelope carries version 9.0 so the request stops at the door with a 202 — this suite
  // never reaches the pipeline (that is pipeline.test.ts, against a real database). What is under
  // test is that it got PAST authentication: the old code 403'd both riders before reading a byte.
  for (const rider of [USER, UNSCOPED]) {
    const rig = await start(rider)
    const body = JSON.stringify({
      ...registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }),
      version: '9.0',
    })
    const response = await fetch(`${rig.url}${NOTIFY_INGEST_PATH}`, { method: 'POST', headers: signed(body), body })
    assert.equal(response.status, 202, 'the signature authenticates; the bearer is not consulted')
    const answer = (await response.json()) as { accepted: boolean; reason: string }
    assert.equal(answer.reason, 'unreadable_version', 'stopped at the version gate, past the auth one')
  }
})

test('ingest refuses an unsigned body even with a valid service token', async () => {
  const rig = await start(SERVICE)
  const body = JSON.stringify(registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }))
  const response = await fetch(`${rig.url}${NOTIFY_INGEST_PATH}`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body,
  })
  // A token leaks; a token alone must not be enough to mint a security notice for anyone.
  assert.equal(response.status, 400)
})

test('ingest refuses a body that was altered after signing', async () => {
  const rig = await start(SERVICE)
  const original = JSON.stringify(registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }))
  const tampered = original.replace(ALICE, BOB)
  const response = await fetch(`${rig.url}${NOTIFY_INGEST_PATH}`, {
    method: 'POST',
    headers: signed(original),
    body: tampered,
  })
  // 401, not 400: this is a failure to authenticate the body, and answering 400 would tell a
  // prober that the signature is checked but the payload is not.
  assert.equal(response.status, 401)
})

test('ingest refuses a stale signature', async () => {
  const rig = await start(SERVICE)
  const body = JSON.stringify(registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }))
  const response = await fetch(`${rig.url}${NOTIFY_INGEST_PATH}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer t',
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signDelivery(body, INGEST_SECRET, Date.now() - 3_600_000),
    },
    body,
  })
  assert.equal(response.status, 401)
})

test('ingest rejects a malformed event with a 400 and an unreadable version with a 202', async () => {
  const rig = await start(SERVICE)

  const bad = JSON.stringify({ topic: 'nonsense' })
  const malformed = await fetch(`${rig.url}${NOTIFY_INGEST_PATH}`, {
    method: 'POST',
    headers: signed(bad),
    body: bad,
  })
  assert.equal(malformed.status, 400)

  const future = JSON.stringify({
    ...registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }),
    version: '9.0',
  })
  const ahead = await fetch(`${rig.url}${NOTIFY_INGEST_PATH}`, {
    method: 'POST',
    headers: signed(future),
    body: future,
  })
  // Not a bad request — the deploy ran in the wrong order. A 400 would make the producer retry
  // for ever against a build that can never read it.
  assert.equal(ahead.status, 202)
  const body = (await ahead.json()) as { accepted: boolean; reason: string }
  assert.equal(body.accepted, false)
  assert.equal(body.reason, 'unreadable_version')
})

/* ------------------------------------------------------------------ operator */

test('broadcasts require an admin and are fanned out by a job, not in the request', async () => {
  const asUser = await start(USER)
  const attempt = await fetch(`${asUser.url}/admin/broadcasts`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ params: { title: 'Maintenance', message: 'Back at 09:00' } }),
  })
  assert.equal(attempt.status, 403)

  const rig = await start(ADMIN)
  const response = await fetch(`${rig.url}/admin/broadcasts`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ params: { title: 'Maintenance', message: 'Back at 09:00' } }),
  })
  assert.equal(response.status, 202)
  assert.deepEqual(rig.calls.broadcasts, ['66666666-6666-4666-8666-666666666666'])
})

test('a broadcast may not be critical', async () => {
  const rig = await start(ADMIN)
  const response = await fetch(`${rig.url}/admin/broadcasts`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ priority: 'critical', params: { title: 'x', message: 'y' } }),
  })
  // The §10.3 exception exists for facts about a user's own account, not for announcements. An
  // operator broadcast that ignores every preference is a megaphone.
  assert.equal(response.status, 400)
})

/**
 * A broadcast may not render a template that carries a single-use credential.
 *
 * `account.verify_email` puts its `verifyUrl` parameter straight into the mail as the one thing the
 * message asks the reader to open, and the scheme guard that refuses a `javascript:` URL lives in
 * the catalogue rule — on the `/ingest` path, where the value comes from a signed producer event.
 * Nothing on this route goes anywhere near it: `params` is taken from the request body as-is. So an
 * operator, or a stolen admin token, could mail every reachable user a link of their choosing under
 * a subject line that says CloudsForge minted it — the most convincing phishing message the estate
 * is capable of sending, sent by the estate.
 *
 * Refused by the property rather than by the template id, so the next template that carries a
 * credential is covered without anybody remembering to add it here.
 */
test('a broadcast may not use a template that carries a single-use credential', async () => {
  const rig = await start(ADMIN)
  const response = await fetch(`${rig.url}/admin/broadcasts`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'account.verify_email',
      params: { handle: 'someone', verifyUrl: 'https://not-cloudsforge.example.test/harvest' },
    }),
  })
  assert.equal(response.status, 400)
  assert.deepEqual(rig.calls.broadcasts, [], 'the fan-out was queued anyway')
})

test('the dead-letter view requires an admin and defaults to the terminal states', async () => {
  const asUser = await start(USER)
  assert.equal(
    (await fetch(`${asUser.url}/admin/deliveries`, { headers: { authorization: 'Bearer t' } })).status,
    403,
  )

  const rig = await start(ADMIN)
  const response = await fetch(`${rig.url}/admin/deliveries`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { deliveries: Array<{ outcome: string }> }
  assert.equal(body.deliveries[0]?.outcome, 'undeliverable_no_transport')
})

test('an unknown channel filter on the dead-letter view is a 400', async () => {
  const rig = await start(ADMIN)
  const response = await fetch(`${rig.url}/admin/deliveries?channel=telepathy`, {
    headers: { authorization: 'Bearer t' },
  })
  assert.equal(response.status, 400)
})

test('the metrics route labels by pattern, never by the concrete path', async () => {
  const rig = await start()
  await fetch(`${rig.url}/notifications/55555555-5555-4555-8555-555555555555/read`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
  })
  const body = await (await fetch(`${rig.url}/metrics`)).text()
  // The concrete id must not appear as a label, or any caller can mint unbounded time series.
  assert.doesNotMatch(body, /55555555-5555-4555-8555-555555555555/)
  assert.match(body, /route="\/notifications\/:id\/read"/)
})
