/**
 * Developer webhooks — the same pipeline, a different addressing scheme, a signed payload.
 *
 * AD-08 is explicit and this file is the whole of the implementation: *"A webhook to a
 * third-party application is a delivery channel with a different addressing scheme and a signed
 * payload. One retry policy, one delivery-history table, one dead-letter view."*
 *
 * So there is no webhook queue, no webhook retry table, no webhook dead-letter page and no
 * webhook worker. A webhook is a `deliveries` row with `channel = 'webhook'` whose `address` is
 * an endpoint URL instead of an email address, and whose target carries a shared secret. It backs
 * off with the same `backoffFor`, dies after the same attempt budget, and appears in the same
 * `GET /admin/deliveries` view as a failed email. Everything below the transport is shared, which
 * is the point — the second pipeline is the thing that rots.
 *
 * ## The signature
 *
 * `signDelivery` from `@cloudsforge/contracts-events`, unmodified. It produces
 * `t=<unix>,v1=<hex>` over `<unix>.<body>`, with the timestamp *inside* the signed message so it
 * cannot be moved without invalidating the signature — which is what makes the freshness window
 * mean anything. A receiver verifies with `verifyDelivery` from the same package, and
 * `webhook.test.ts` does exactly that rather than recomputing an HMAC by hand: a test that
 * reimplements the signature proves the test can sign, not that the receiver can verify.
 *
 * ## The secret
 *
 * Never logged, never returned by any route, never in an error message. It is the only thing
 * standing between a developer's endpoint and anyone who can POST to it. A webhook target with no
 * secret is refused — `invalid_payload`, permanently — rather than sent unsigned: an unsigned
 * delivery teaches a receiver to accept unsigned deliveries.
 */

import { SIGNATURE_HEADER, signDelivery } from '@cloudsforge/contracts-events'
import { failure, type ChannelAdapter, type OutboundMessage, type SendOutcome } from './channels.ts'

export const DELIVERY_ID_HEADER = 'cf-delivery-id'
export const NOTIFICATION_ID_HEADER = 'cf-notification-id'

export interface WebhookRequest {
  readonly headers: Record<string, string>
  readonly body: string
  readonly signal: AbortSignal
}

export interface WebhookResponse {
  readonly status: number
}

export interface WebhookOptions {
  /** Test seam. Production uses `fetch`; the suite passes a receiver that verifies the signature. */
  readonly post?: (url: string, request: WebhookRequest) => Promise<WebhookResponse>
  readonly deadlineMs?: number
  readonly now?: () => number
}

/**
 * The body a subscriber receives.
 *
 * Deliberately **not** the event envelope. A developer webhook is a notification about a user's
 * account, not a republication of an internal domain event: forwarding the envelope would leak
 * the estate's topic names, producer identities and payload shapes to third parties, and would
 * commit this service to keeping them stable for external consumers for ever.
 */
export interface WebhookPayload {
  readonly id: string
  readonly notificationId: string
  readonly userId: string
  readonly category: string
  readonly priority: string
  readonly template: string
  readonly subject: string
  readonly body: string
  readonly link: string
  readonly params: Record<string, unknown>
  readonly createdAt: string
}

export function webhookPayload(message: OutboundMessage): WebhookPayload {
  return {
    // Stable across every retry of this delivery, so a receiver's own dedupe works.
    id: message.deliveryId,
    notificationId: message.notificationId,
    userId: message.userId,
    category: message.category,
    priority: message.priority,
    template: message.templateId,
    subject: message.subject,
    body: message.body,
    link: message.link,
    params: message.params,
    createdAt: message.createdAt,
  }
}

export function webhookAdapter(options: WebhookOptions = {}): ChannelAdapter {
  const post = options.post ?? defaultPost
  const deadlineMs = options.deadlineMs ?? 5_000
  const now = options.now ?? Date.now

  return {
    channel: 'webhook',
    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (!message.address) {
        return failure('no_address', false, 'no webhook endpoint registered')
      }
      if (!message.secret) {
        // Not retryable: a missing secret is a configuration fault that will not resolve itself,
        // and the alternative — sending it unsigned — is worse than not sending it.
        return failure('invalid_payload', false, 'webhook endpoint has no signing secret')
      }

      let url: URL
      try {
        url = new URL(message.address)
      } catch {
        return failure('invalid_payload', false, 'webhook endpoint is not a valid URL')
      }
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        // A signed payload over plaintext is a payload anyone on the path can read. Loopback is
        // exempt so the sandbox simulator can run without a certificate.
        return failure('invalid_payload', false, 'webhook endpoint must be https')
      }

      // Signed over the exact bytes that are sent. Serialise once and send that string, rather
      // than re-stringifying: two JSON.stringify calls on one object agree today and are a
      // signature mismatch the day a field is added conditionally.
      const body = JSON.stringify(webhookPayload(message))
      const signature = signDelivery(body, message.secret, now())

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deadlineMs)
      try {
        const response = await post(message.address, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            [SIGNATURE_HEADER]: signature,
            [DELIVERY_ID_HEADER]: message.deliveryId,
            [NOTIFICATION_ID_HEADER]: message.notificationId,
            'user-agent': 'CloudsForge-Notify/1',
          },
          body,
          signal: controller.signal,
        })
        if (response.status >= 200 && response.status < 300) {
          return { ok: true, providerRef: message.deliveryId }
        }
        // 410 Gone is the endpoint saying "stop": honouring it is why a deleted integration does
        // not generate six retries per notification for ever.
        if (response.status === 410) return failure('rejected', false, 'endpoint answered 410 Gone')
        if (response.status >= 500 || response.status === 429) {
          return failure('upstream_error', true, `endpoint answered ${response.status}`)
        }
        return failure('rejected', false, `endpoint answered ${response.status}`)
      } catch (err) {
        if (controller.signal.aborted) return failure('timeout', true, `no answer within ${deadlineMs}ms`)
        // The message is truncated and never includes the request, because the request holds a
        // signature computed with the developer's secret.
        return failure('upstream_error', true, err instanceof Error ? err.message : String(err))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function defaultPost(url: string, request: WebhookRequest): Promise<WebhookResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    // A developer endpoint that redirects is a developer endpoint that could redirect our signed
    // payload somewhere else. Never follow one.
    redirect: 'manual',
  })
  return { status: response.status }
}
