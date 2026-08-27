/**
 * The channel adapters.
 *
 * Nothing here opens a socket. The email adapter is constructed with no transport and with a
 * recording one; the webhook adapter is given a receiver that is a function; the gateway adapter
 * is given a `post` that answers from a variable. That is the constraint — never send a real
 * email, push or SMS in a test — made structural rather than remembered.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELIVERY_TOLERANCE_MS, SIGNATURE_HEADER, verifyDelivery } from '@cloudsforge/contracts-events'
import { gatewayAdapter, inAppAdapter, recordingAdapter, registryOf, type OutboundMessage } from './channels.ts'
import { emailAdapter, QUOTA_RETRY_FLOOR_MS, retryAfterMs, smtpConfigured } from './email.ts'
import { DELIVERY_ID_HEADER, webhookAdapter } from './webhook.ts'
import type { SmtpConfig } from './env.ts'
import { ALICE } from './testsupport.ts'

const UNCONFIGURED: SmtpConfig = {
  host: null,
  port: 587,
  secure: false,
  user: null,
  pass: null,
  from: null,
  replyTo: null,
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    deliveryId: '33333333-3333-4333-8333-333333333333',
    notificationId: '44444444-4444-4444-8444-444444444444',
    userId: ALICE,
    channel: 'email',
    category: 'security',
    priority: 'critical',
    templateId: 'security.key_exported',
    // NOT a reserved domain, and that is now load-bearing rather than incidental. `reserved.ts`
    // refuses `.test`, `.example`, `.invalid`, `.localhost` and the `example.*` documentation
    // domains before the transport is opened, so a fixture addressed to `alice@example.test` can no
    // longer reach the SMTP classification paths this file exists to test — it is rejected first,
    // and every 4xx/5xx case silently stops testing anything.
    //
    // The guarantee that no test ever mails a real person is the `transport` seam, not the domain:
    // every case here passes a recording transport or none at all. `cloudsforge.online` is the
    // estate's own domain, so even a mistake has no third party at the other end.
    address: 'alice@cloudsforge.online',
    secret: null,
    subject: 'A private key left the platform',
    body: 'The private key for a wallet was exported.',
    link: 'https://app.cloudsforge.test/settings/security/exports',
    params: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/* ------------------------------------------------------------------ in-app */

test('in-app always succeeds — it is the floor the critical guarantee stands on', async () => {
  const outcome = await inAppAdapter().send(message({ channel: 'in_app', address: null }))
  assert.deepEqual(outcome, { ok: true, providerRef: message().notificationId })
})

/* ------------------------------------------------------------------ email */

test('an unconfigured SMTP transport is undeliverable_no_transport, not an error', async () => {
  const adapter = emailAdapter({ smtp: UNCONFIGURED })
  const outcome = await adapter.send(message())

  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'no_transport')
  // Not retryable, because no number of retries conjures a mail server. This is what lands the
  // delivery in `undeliverable` rather than burning six attempts and dead-lettering.
  assert.equal(outcome.retryable, false)
  assert.match(outcome.detail, /SMTP_HOST/)
})

test('SMTP with a host but no From address is still no transport', () => {
  // The connection would be accepted and the message rejected at the provider, which is a much
  // harder failure to diagnose than the honest answer here.
  assert.equal(smtpConfigured({ ...UNCONFIGURED, host: 'smtp.example.test' }), false)
  assert.equal(smtpConfigured({ ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' }), true)
})

test('email with no address on file is no_address, and is not retried', async () => {
  const sent: unknown[] = []
  const adapter = emailAdapter({
    smtp: UNCONFIGURED,
    transport: async () => ({
      async sendMail(m) {
        sent.push(m)
        return { messageId: 'never' }
      },
    }),
  })
  const outcome = await adapter.send(message({ address: null }))
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'no_address')
  assert.equal(outcome.retryable, false)
  assert.equal(sent.length, 0, 'nothing was handed to a transport')
})

test('a reserved domain is rejected permanently and never reaches the transport', async () => {
  // The assertion that proves no allowance is spent. `deliveries.max_attempts` is 6, so a
  // retryable answer here would cost six units of a quota real recipients share, per synthetic
  // account, for an address that can never resolve.
  const sent: unknown[] = []
  const adapter = emailAdapter({
    smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'CloudsForge <no-reply@cloudsforge.online>' },
    transport: async () => ({
      async sendMail(m) {
        sent.push(m)
        return { messageId: 'never' }
      },
    }),
  })

  // The address the estate's own monitor registers, ~95 times an hour.
  const outcome = await adapter.send(message({ address: 'beacon+9f2a@beacon.test' }))
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'reserved_domain')
  assert.equal(outcome.retryable, false, 'no number of attempts makes a reserved domain resolvable')
  assert.equal(sent.length, 0, 'nothing was handed to a transport, so nothing was charged')
})

test('the reserved-domain refusal is DISTINGUISHABLE from every other permanent refusal', async () => {
  // The point of the reason, and the mutation this kills. Reverting `reserved_domain` to
  // `rejected` leaves the test above passing on `ok`, `retryable` and `sent.length` — every
  // property that describes the BEHAVIOUR is unchanged, because the behaviour was already right.
  // What breaks is the only thing that was ever wrong: an operator's ability to select this one
  // series out of the five call sites that write `rejected`, and to alert on it above zero.
  //
  // micro-org#390: for six days on mainnet the rule was in the tree, the running process did not
  // have it, 1,535 of 1,552 deliveries in a week went to `beacon.test`, and the first thing that
  // noticed was a provider dashboard reading 241 against a 150/day allowance. A counter nobody can
  // select is a counter nobody alerts on.
  const adapter = emailAdapter({
    smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'CloudsForge <no-reply@cloudsforge.online>' },
    transport: async () => ({
      // A transport that refuses with a 5xx, which is the OTHER permanent SMTP refusal and the one
      // this must not be confused with.
      async sendMail() {
        throw Object.assign(new Error('SMTP 550 mailbox unavailable'), { responseCode: 550 })
      },
    }),
  })

  const reserved = await adapter.send(message({ address: 'beacon+9f2a@beacon.test' }))
  const refused = await adapter.send(message({ address: 'someone@cloudsforge.online' }))

  assert.equal(reserved.ok, false)
  assert.equal(refused.ok, false)
  if (reserved.ok || refused.ok) return
  assert.equal(reserved.reason, 'reserved_domain')
  assert.equal(refused.reason, 'rejected')
  assert.notEqual(
    reserved.reason,
    refused.reason,
    'an address that can never exist and a mailbox that refused share one label again',
  )
})

test('a configured transport is handed a plain-text message and the link', async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const adapter = emailAdapter({
    smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'CloudsForge <no-reply@example.test>' },
    transport: async () => ({
      async sendMail(m) {
        sent.push({ to: m.to, subject: m.subject, text: m.text })
        return { messageId: '<abc@example.test>' }
      },
    }),
  })
  const outcome = await adapter.send(message())
  assert.deepEqual(outcome, { ok: true, providerRef: '<abc@example.test>' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.to, 'alice@cloudsforge.online')
  assert.match(sent[0]?.text ?? '', /app\.cloudsforge\.test/)
  // No HTML anywhere. Every template parameter is domain data from an event this service did not
  // write, and an HTML body would make each one an injection surface.
  assert.doesNotMatch(sent[0]?.text ?? '', /<[a-z]/i)
})

test('a 4xx SMTP reply retries and a 5xx does not', async () => {
  const build = (responseCode: number) =>
    emailAdapter({
      smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' },
      transport: async () => ({
        async sendMail() {
          throw Object.assign(new Error('refused'), { responseCode })
        },
      }),
    })

  const transient = await build(451).send(message())
  assert.equal(transient.ok, false)
  if (!transient.ok) assert.equal(transient.retryable, true)

  const permanent = await build(550).send(message())
  assert.equal(permanent.ok, false)
  if (!permanent.ok) assert.equal(permanent.retryable, false)
})

test('a rate limit dressed as a 5xx auth failure is RETRYABLE (#201)', async () => {
  const build = (responseCode: number, text: string) =>
    emailAdapter({
      smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' },
      transport: async () => ({
        async sendMail() {
          throw Object.assign(new Error(text), { responseCode })
        },
      }),
    })

  // The exact reply this estate's provider sends when the daily allowance is gone: a 5xx AUTH
  // code, carrying the enhanced code for "credentials invalid", for a condition that is temporary
  // and that names its own retry-after. On the digit alone it reads permanent, which sent 707
  // messages to `undeliverable` on 2026-08-05 — including the verification links new users need
  // to sign in at all.
  const quota = await build(
    535,
    '535 5.7.8 Your account has reached its daily sending limit. Please upgrade your plan or retry in 19m21s.',
  ).send(message())
  assert.equal(quota.ok, false)
  if (!quota.ok) {
    assert.equal(quota.retryable, true, 'a quota rejection must be retried, not discarded')
    // `quota_exhausted`, not `upstream_error`, since micro-org#243. The reason IS the diagnosis:
    // it is the label on `notify_failed_total`, the value in `deliveries.reason` and the suffix on
    // the generated `outcome` column, and while it read `upstream_error` the estate concluded
    // three times over that its SMTP credentials were broken. They were not.
    assert.equal(quota.reason, 'quota_exhausted')
    // The provider named its own retry-after in the text — 19m21s — and it is carried out rather
    // than replaced by an attempt-count backoff that reaches max_attempts in about thirty seconds.
    assert.equal(quota.retryAfterMs, 19 * 60_000 + 21_000)
  }

  // AND THE CONTROL, or the carve-out would just be "retry every 5xx": a genuine credential
  // failure carries none of those phrases and must still fail fast rather than burn six attempts.
  const badCreds = await build(535, '535 5.7.8 Authentication credentials invalid').send(message())
  assert.equal(badCreds.ok, false)
  if (!badCreds.ok) {
    assert.equal(badCreds.retryable, false)
    assert.equal(badCreds.reason, 'rejected')
  }
})

test('a volume refusal that names no retry-after waits the floor, not an attempt-count backoff', async () => {
  const adapter = emailAdapter({
    smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' },
    transport: async () => ({
      async sendMail() {
        // A provider that says only "later". Common, and the case where guessing short is worst:
        // the shared backoff reaches `max_attempts` = 6 in about thirty seconds, so every guess
        // derived from the attempt count is spent inside a window that is measured in hours.
        throw Object.assign(new Error('421 4.7.0 too many messages, try again later'), {
          responseCode: 421,
        })
      },
    }),
  })

  const outcome = await adapter.send(message())
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'quota_exhausted')
  assert.equal(outcome.retryable, true)
  assert.equal(outcome.retryAfterMs, QUOTA_RETRY_FLOOR_MS)
})

test('the retry-after a provider states is read out of the text, because SMTP has no header', () => {
  // HTTP has `Retry-After`. SMTP has a sentence, so this is a parser over free text and every case
  // below is a shape a provider has been seen to write or could reasonably write tomorrow.
  assert.equal(retryAfterMs('535 5.7.8 daily sending limit reached, retry in 19m21s'), 19 * 60_000 + 21_000)
  assert.equal(retryAfterMs('421 too many messages, try again in 30 seconds'), 30_000)
  assert.equal(retryAfterMs('rate limited: retry in 45m'), 45 * 60_000)

  // Unrecognised is null, never a guess. The caller answers null with the documented floor, which
  // is a decision somebody made once rather than a number this function invented.
  assert.equal(retryAfterMs('535 5.7.8 Authentication credentials invalid'), null)
  assert.equal(retryAfterMs('quota exceeded, try again later'), null)
  assert.equal(retryAfterMs('retry in 0s'), null)

  // Clamped at an hour, in the cheap direction. A parked delivery costs one refused connection per
  // wake-up and no attempt budget, so waking early is nearly free; waiting long is a verification
  // link sitting in a queue after the allowance has already come back.
  assert.equal(retryAfterMs('retry in 2h'), 3_600_000)
  assert.equal(retryAfterMs('retry in 30h'), 3_600_000)
})

/* ------------------------------------------------------------------ gateways */

test('a push or SMS channel with no gateway is no_transport, exactly like email', async () => {
  for (const channel of ['web_push', 'mobile_push', 'sms'] as const) {
    const outcome = await gatewayAdapter({ channel, url: null, token: null }).send(
      message({ channel, address: 'somewhere' }),
    )
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'no_transport', channel)
    assert.equal(outcome.retryable, false, channel)
  }
})

test('a gateway 5xx retries, a 4xx does not, and the idempotency key is the delivery id', async () => {
  const seen: Array<Record<string, unknown>> = []
  const build = (status: number) =>
    gatewayAdapter({
      channel: 'sms',
      url: 'https://sms.example.test/send',
      token: 'gateway-token',
      post: async (_url, init) => {
        seen.push(JSON.parse(init.body) as Record<string, unknown>)
        return { status, body: '' }
      },
    })

  const ok = await build(200).send(message({ channel: 'sms', address: '+441234567890' }))
  assert.equal(ok.ok, true)
  assert.equal(seen[0]?.['idempotencyKey'], message().deliveryId)

  const transient = await build(503).send(message({ channel: 'sms', address: '+441234567890' }))
  assert.equal(transient.ok, false)
  if (!transient.ok) assert.equal(transient.retryable, true)

  const permanent = await build(422).send(message({ channel: 'sms', address: '+441234567890' }))
  assert.equal(permanent.ok, false)
  if (!permanent.ok) assert.equal(permanent.retryable, false)
})

/* ------------------------------------------------------------------ webhooks */

test('a webhook delivery carries a signature the receiver can verify', async () => {
  const secret = 'a-developer-webhook-secret-value'
  let verified: ReturnType<typeof verifyDelivery> | null = null
  let receivedBody = ''

  const adapter = webhookAdapter({
    // The "receiver" — a third-party application. It verifies with the shared package's own
    // `verifyDelivery` rather than recomputing an HMAC, because a test that reimplements the
    // signature proves the test can sign, not that a subscriber can verify.
    post: async (_url, request) => {
      receivedBody = request.body
      const presented = request.headers[SIGNATURE_HEADER]
      verified = verifyDelivery(request.body, presented ?? '', secret)
      return { status: 200 }
    },
  })

  const outcome = await adapter.send(
    message({ channel: 'webhook', address: 'https://developer.example.test/hooks/cf', secret }),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(verified, { ok: true, keyIndex: 0 })
  // Signed over exactly the bytes sent — the receiver parses the same string it verified.
  const payload = JSON.parse(receivedBody) as Record<string, unknown>
  assert.equal(payload['id'], message().deliveryId)
  assert.equal(payload['userId'], ALICE)
  assert.equal(payload['category'], 'security')
})

test('a tampered webhook body fails verification', async () => {
  const secret = 'a-developer-webhook-secret-value'
  let verified: ReturnType<typeof verifyDelivery> | null = null

  await webhookAdapter({
    post: async (_url, request) => {
      // One byte changed in transit.
      const tampered = request.body.replace('"category":"security"', '"category":"market"')
      verified = verifyDelivery(tampered, request.headers[SIGNATURE_HEADER] ?? '', secret)
      return { status: 200 }
    },
  }).send(message({ channel: 'webhook', address: 'https://developer.example.test/h', secret }))

  assert.deepEqual(verified, { ok: false, reason: 'mismatch' })
})

test('a stale webhook signature is refused by the receiver', async () => {
  const secret = 'a-developer-webhook-secret-value'
  let verified: ReturnType<typeof verifyDelivery> | null = null
  const signedAt = Date.now() - DELIVERY_TOLERANCE_MS - 60_000

  await webhookAdapter({
    now: () => signedAt,
    post: async (_url, request) => {
      verified = verifyDelivery(request.body, request.headers[SIGNATURE_HEADER] ?? '', secret)
      return { status: 200 }
    },
  }).send(message({ channel: 'webhook', address: 'https://developer.example.test/h', secret }))

  // The timestamp is inside the signed message, so a captured request cannot be replayed by
  // moving it — it can only be replayed inside the window, which is what the window is for.
  assert.deepEqual(verified, { ok: false, reason: 'stale' })
})

test('a webhook endpoint with no secret is refused rather than sent unsigned', async () => {
  let called = false
  const outcome = await webhookAdapter({
    post: async () => {
      called = true
      return { status: 200 }
    },
  }).send(message({ channel: 'webhook', address: 'https://developer.example.test/h', secret: null }))

  assert.equal(called, false, 'an unsigned delivery must never leave')
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'invalid_payload')
  assert.equal(outcome.retryable, false)
})

test('a plaintext webhook endpoint is refused, and loopback is allowed for the sandbox', async () => {
  const secret = 'a-developer-webhook-secret-value'
  const adapter = webhookAdapter({ post: async () => ({ status: 200 }) })

  const plaintext = await adapter.send(
    message({ channel: 'webhook', address: 'http://developer.example.test/h', secret }),
  )
  assert.equal(plaintext.ok, false)
  if (!plaintext.ok) assert.equal(plaintext.reason, 'invalid_payload')

  const loopback = await adapter.send(
    message({ channel: 'webhook', address: 'http://127.0.0.1:9999/h', secret }),
  )
  assert.equal(loopback.ok, true)
})

test('410 Gone stops retrying; 429 and 5xx keep retrying', async () => {
  const secret = 'a-developer-webhook-secret-value'
  const build = (status: number) => webhookAdapter({ post: async () => ({ status }) })
  const send = (status: number) =>
    build(status).send(message({ channel: 'webhook', address: 'https://d.example.test/h', secret }))

  const gone = await send(410)
  assert.equal(gone.ok, false)
  if (!gone.ok) assert.equal(gone.retryable, false)

  for (const status of [429, 500, 502]) {
    const outcome = await send(status)
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.retryable, true, String(status))
  }
})

test('the delivery id header is stable, so a receiver can dedupe a retry', async () => {
  const secret = 'a-developer-webhook-secret-value'
  const headers: Array<Record<string, string>> = []
  const adapter = webhookAdapter({
    post: async (_url, request) => {
      headers.push(request.headers)
      return { status: 200 }
    },
  })
  const outbound = message({ channel: 'webhook', address: 'https://d.example.test/h', secret })
  await adapter.send(outbound)
  await adapter.send(outbound)
  assert.equal(headers[0]?.[DELIVERY_ID_HEADER], outbound.deliveryId)
  assert.equal(headers[1]?.[DELIVERY_ID_HEADER], outbound.deliveryId)
})

/* ------------------------------------------------------------------ registry and fake */

test('two adapters for one channel is refused at construction', () => {
  assert.throws(() => registryOf([inAppAdapter(), inAppAdapter()]), /two adapters/)
})

test('the recording adapter records rather than sends, and can be made to fail', async () => {
  const adapter = recordingAdapter('email')
  adapter.failNext(2, { ok: false, reason: 'upstream_error', retryable: true, detail: 'boom' })

  assert.equal((await adapter.send(message())).ok, false)
  assert.equal((await adapter.send(message())).ok, false)
  assert.equal((await adapter.send(message())).ok, true)
  assert.equal(adapter.sent.length, 1)
  assert.equal(adapter.sent[0]?.message.subject, 'A private key left the platform')
})
