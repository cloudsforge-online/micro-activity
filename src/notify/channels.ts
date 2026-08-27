/**
 * Channels as adapters behind one interface — AD-08.
 *
 * Everything a channel is allowed to be is in `ChannelAdapter`: take a rendered message, try to
 * send it, say what happened. No adapter knows about preferences, retries, digests, dedupe or the
 * database, which is what keeps "add SMS" from touching the pipeline.
 *
 * ## The two things an adapter must get right
 *
 * **1. Retryable or not.** This single boolean decides whether a failure costs an attempt and
 * comes back in a minute, or lands in the dead-letter view immediately. A wrong `true` is a
 * service that retries an invalid phone number every minute for six attempts. A wrong `false`
 * throws away a notification because a gateway had a bad second.
 *
 * **2. `no_transport` is not an error.** A channel with nothing configured returns
 * `{ ok: false, reason: 'no_transport', retryable: false }` and the delivery is recorded as
 * `undeliverable_no_transport` — retained, countable, visible. The estate's own `.env.example`
 * says of SMTP: "Unset = no mail … which is how it worked before this existed and is a supported
 * way to run." Throwing here would turn a deployment choice into a page.
 *
 * No adapter in this file, or any other, sends anything under test. `recordingAdapter` is the
 * only adapter a test ever constructs.
 */

import type { Category, Channel, FailureReason, Priority } from './model.ts'

/**
 * One rendered message, ready to send.
 *
 * `secret` is present only for channels that sign — today, developer webhooks. It is carried
 * here and **never logged, never returned over HTTP and never put in an error message**: it is
 * the credential a receiver uses to prove the payload came from this platform, and the estate has
 * already been burned once by logging a live credential.
 */
export interface OutboundMessage {
  readonly deliveryId: string
  readonly notificationId: string
  readonly userId: string
  readonly channel: Channel
  readonly category: Category
  readonly priority: Priority
  readonly templateId: string
  /** Email address, push token, E.164 number, or webhook URL. Null for `in_app`. */
  readonly address: string | null
  readonly secret: string | null
  readonly subject: string
  readonly body: string
  readonly link: string
  readonly params: Record<string, unknown>
  readonly createdAt: string
}

export type SendOutcome =
  | { readonly ok: true; readonly providerRef?: string }
  | {
      readonly ok: false
      readonly reason: FailureReason
      readonly retryable: boolean
      /** Safe to store in `deliveries.last_error`. Must never contain a credential. */
      readonly detail: string
      /**
       * How long the provider says to wait, when it says.
       *
       * Absent means "use the shared exponential backoff", which is right for a failure whose
       * duration nobody knows. Present means the provider stated a duration — the estate's mail
       * provider names its own retry-after in the text of an exhausted-allowance reply — and
       * guessing shorter is not clever, it is six refused attempts inside the window the provider
       * just told us to sit out. See `classify` in `email.ts` and `dispatchDue` in `pipeline.ts`.
       */
      readonly retryAfterMs?: number
    }

export interface ChannelAdapter {
  readonly channel: Channel
  send(message: OutboundMessage): Promise<SendOutcome>
}

export type AdapterRegistry = ReadonlyMap<Channel, ChannelAdapter>

export function registryOf(adapters: readonly ChannelAdapter[]): AdapterRegistry {
  const map = new Map<Channel, ChannelAdapter>()
  for (const adapter of adapters) {
    if (map.has(adapter.channel)) throw new Error(`two adapters registered for ${adapter.channel}`)
    map.set(adapter.channel, adapter)
  }
  return map
}

export function failure(
  reason: FailureReason,
  retryable: boolean,
  detail: string,
  retryAfterMs?: number,
): SendOutcome {
  return {
    ok: false,
    reason,
    retryable,
    detail: detail.slice(0, 500),
    // Omitted rather than set to undefined: `exactOptionalPropertyTypes` is on, and a present key
    // holding undefined is not the same value as an absent one to anything that spreads it.
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

/* ------------------------------------------------------------------ in-app */

/**
 * The floor channel.
 *
 * It cannot fail, and that is its entire purpose. The notification row was written before this
 * adapter ran, and `GET /notifications` reads that row — so "delivering" in-app is confirming
 * something that is already true. This is what makes §10.3's "always send on at least one
 * channel" a guarantee rather than an aspiration on a deployment with no SMTP configured.
 */
export function inAppAdapter(): ChannelAdapter {
  return {
    channel: 'in_app',
    async send(message) {
      return { ok: true, providerRef: message.notificationId }
    },
  }
}

/* ------------------------------------------------------------------ push and SMS gateways */

export interface GatewayOptions {
  readonly channel: Channel
  readonly url: string | null
  readonly token: string | null
  /** Test seam. Production uses `fetch`; nothing in the suite ever supplies a real one. */
  readonly post?: (url: string, init: GatewayRequest) => Promise<GatewayResponse>
  readonly deadlineMs?: number
}

export interface GatewayRequest {
  readonly headers: Record<string, string>
  readonly body: string
  readonly signal: AbortSignal
}

export interface GatewayResponse {
  readonly status: number
  readonly body: string
}

/**
 * Web push, mobile push and SMS.
 *
 * One implementation for three channels, because at this layer they are the same operation: post
 * a rendered message to a gateway that owns the protocol. This service deliberately does not
 * implement VAPID, APNs or a telco API — writing an untested provider integration and calling it
 * done is worse than a seam that is honest about being a seam. When a provider is chosen, this
 * function is replaced by three, and nothing outside this file changes.
 *
 * 5xx and a timeout are retryable; 4xx is not — a gateway that says the token is dead will keep
 * saying it, and retrying is how one bad push token generates six failures an hour forever.
 */
export function gatewayAdapter(options: GatewayOptions): ChannelAdapter {
  const post = options.post ?? defaultPost
  const deadlineMs = options.deadlineMs ?? 5_000

  return {
    channel: options.channel,
    async send(message) {
      if (options.url === null) {
        return failure('no_transport', false, `${options.channel} has no configured gateway`)
      }
      if (!message.address) {
        return failure('no_address', false, `no ${options.channel} address on file for this user`)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deadlineMs)
      try {
        const response = await post(options.url, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({
            to: message.address,
            subject: message.subject,
            body: message.body,
            link: message.link,
            category: message.category,
            priority: message.priority,
            // The receiver dedupes on this. Same value on every retry of one delivery, which is
            // what makes a gateway that answered slowly not send the message twice.
            idempotencyKey: message.deliveryId,
          }),
          signal: controller.signal,
        })
        if (response.status >= 200 && response.status < 300) {
          return { ok: true, providerRef: message.deliveryId }
        }
        if (response.status >= 500) {
          return failure('upstream_error', true, `gateway answered ${response.status}`)
        }
        return failure('rejected', false, `gateway answered ${response.status}`)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        if (controller.signal.aborted) return failure('timeout', true, `no answer within ${deadlineMs}ms`)
        return failure('upstream_error', true, detail)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function defaultPost(url: string, init: GatewayRequest): Promise<GatewayResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  })
  return { status: response.status, body: await response.text() }
}

/* ------------------------------------------------------------------ the test fake */

export interface RecordedSend {
  readonly message: OutboundMessage
  readonly at: number
}

export interface RecordingAdapter extends ChannelAdapter {
  readonly sent: readonly RecordedSend[]
  /** Fail the next `times` sends with this outcome, then behave normally again. */
  failNext(times: number, outcome: SendOutcome): void
  /** Fail every send from now on. For the dead-letter test. */
  failAlways(outcome: SendOutcome): void
  reset(): void
}

/**
 * The only adapter a test constructs.
 *
 * It records rather than sends, which is the constraint that makes "never send a real email, push
 * or SMS in a test" structural instead of a rule people remember. It is also programmable, so a
 * retry-and-dead-letter test drives a channel that fails a known number of times rather than one
 * that fails because the network happened to be down.
 */
export function recordingAdapter(channel: Channel): RecordingAdapter {
  const sent: RecordedSend[] = []
  let failuresLeft = 0
  let programmed: SendOutcome | null = null
  let permanent: SendOutcome | null = null

  return {
    channel,
    sent,
    failNext(times, outcome) {
      failuresLeft = times
      programmed = outcome
    },
    failAlways(outcome) {
      permanent = outcome
    },
    reset() {
      sent.length = 0
      failuresLeft = 0
      programmed = null
      permanent = null
    },
    async send(message) {
      if (permanent) return permanent
      if (failuresLeft > 0 && programmed) {
        failuresLeft -= 1
        return programmed
      }
      sent.push({ message, at: Date.now() })
      return { ok: true, providerRef: `recorded-${sent.length}` }
    },
  }
}
