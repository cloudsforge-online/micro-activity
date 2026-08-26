/**
 * The vocabulary: categories, priorities, channels, digest cadences, and the reason codes.
 *
 * One file, because every other module in this service spells these, and a channel name that is
 * a bare string in six places is a channel name that will be misspelled in one of them. The
 * `CHECK` constraints in `migrations.ts` are generated from the same arrays, so the database and
 * the type cannot drift.
 *
 * ## The invariant this file exists to make unspellable
 *
 * 04-domain-model §10.3: *`critical` security notifications ignore preferences and always send on
 * at least one channel. A user cannot opt out of being told their key left.*
 *
 * That is enforced in three independent places, deliberately, because a single guard is a single
 * line for someone to delete:
 *
 *   1. **Here, in the type.** `NonCriticalPriority` excludes `critical`, and the function that
 *      applies preferences (`routing.ts`) takes that type. Applying a preference to a critical
 *      notification does not compile.
 *   2. **In `routing.ts`.** The critical path returns before preferences are loaded at all, and
 *      its return type is a non-empty tuple, so "delivered nowhere" has no representation.
 *   3. **In the database.** `notifications` carries
 *      `check (priority <> 'critical' or suppressed_reason is null)` and
 *      `check (priority <> 'critical' or channel_count >= 1)`. A critical notification that was
 *      suppressed, or routed to nothing, cannot be stored — not by this service, not by a
 *      migration, not by an operator with psql.
 */

/**
 * The categories a user has preferences over.
 *
 * The first sixteen are exactly 04-domain-model §10.1's list, so every activity category is
 * representable as a notification preference (FEA-41's acceptance criterion).
 *
 * `system` is the seventeenth and is not from that list. It carries operator broadcasts and
 * service incidents, which are not user activity: they are things the platform says about
 * itself. Filing them under `account` would have let a user mute a maintenance notice through a
 * preference page that says nothing about maintenance, which is the sort of surprise that ends
 * with "nobody told me it was down".
 */
export const CATEGORIES = [
  'account',
  'security',
  'wallet',
  'deposit',
  'withdrawal',
  'transfer',
  'conversion',
  'token',
  'ownership',
  'trading',
  'market',
  'reward',
  'community',
  'governance',
  'api',
  'billing',
  'system',
] as const

export type Category = (typeof CATEGORIES)[number]

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES)

export function isCategory(value: string): value is Category {
  return CATEGORY_SET.has(value)
}

export const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const

export type Priority = (typeof PRIORITIES)[number]

/**
 * Everything except `critical`.
 *
 * This is the type the preference filter accepts. It is the cheapest possible enforcement of
 * §10.3: a future change that tries to run a critical notification through the preference filter
 * is a type error at the call site rather than a silent opt-out discovered by a user who was
 * never told their key left.
 */
export type NonCriticalPriority = Exclude<Priority, 'critical'>

const PRIORITY_SET: ReadonlySet<string> = new Set(PRIORITIES)

export function isPriority(value: string): value is Priority {
  return PRIORITY_SET.has(value)
}

/** Higher is more urgent. Used against a preference's `min_priority`. */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
})

/**
 * Delivery channels.
 *
 * `webhook` sits in this list rather than in a parallel one, and that placement is AD-08's whole
 * point: *"a webhook to a third-party application is a delivery channel with a different
 * addressing scheme and a signed payload. One retry policy, one delivery-history table, one
 * dead-letter view."* If a webhook ever needs a second pipeline, it is because something else has
 * gone wrong.
 */
export const CHANNELS = ['in_app', 'email', 'web_push', 'mobile_push', 'sms', 'webhook'] as const

export type Channel = (typeof CHANNELS)[number]

const CHANNEL_SET: ReadonlySet<string> = new Set(CHANNELS)

export function isChannel(value: string): value is Channel {
  return CHANNEL_SET.has(value)
}

/**
 * The channel that is always available.
 *
 * In-app needs no address, no credential and no third party: "delivering" it means the
 * notification row is readable at `GET /notifications`, which is true the instant the row exists.
 * That is what makes "always send on at least one channel" an unconditional guarantee rather than
 * a hope that the user has verified an email address — and it is why a critical notification can
 * never be `undeliverable_no_transport`.
 */
export const FLOOR_CHANNEL: Channel = 'in_app'

/**
 * Preferred order when a critical notification fans out.
 *
 * Ordering matters only for the operator reading the delivery history; every available channel is
 * used. `in_app` is first because it is the one that cannot fail.
 */
export const CRITICAL_CHANNEL_ORDER: readonly Channel[] = Object.freeze([
  'in_app',
  'email',
  'mobile_push',
  'web_push',
  'sms',
  'webhook',
])

export const DIGESTS = ['instant', 'hourly', 'daily', 'off'] as const

export type Digest = (typeof DIGESTS)[number]

const DIGEST_SET: ReadonlySet<string> = new Set(DIGESTS)

export function isDigest(value: string): value is Digest {
  return DIGEST_SET.has(value)
}

/** The two cadences that actually batch. `instant` and `off` never produce a digest row. */
export type Cadence = Extract<Digest, 'hourly' | 'daily'>

/**
 * Why a notification was not delivered on any channel.
 *
 * These are the `reason` label on `notify_suppressed_total`, so they are a closed set: a free-text
 * reason is a label with unbounded cardinality, which takes the scrape target down.
 */
export const SUPPRESSION_REASONS = [
  /** Every candidate channel had `enabled = false`. */
  'channel_disabled',
  /** Every candidate channel's `min_priority` was above this notification's priority. */
  'below_min_priority',
  /** Every candidate channel had `digest = off`. */
  'digest_off',
  /** A mixture of the above — no single reason describes it. */
  'preferences',
  /** The topic arrived but no rule maps it to a notification. Not an error; not everything is one. */
  'no_rule',
  /**
   * A rule matched and decided this particular event is not notifiable — a sign-in from a device
   * the user has used before, a reconciliation run that concerns operators only. Distinct from
   * `no_recipient`, which is a payload this service could not read.
   */
  'not_applicable',
  /** The rule matched but named no recipient — usually a payload without a user id. */
  'no_recipient',
  /** A notification with this `dedupe_key` already exists for this user. */
  'duplicate',
] as const

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/**
 * Why one delivery attempt failed.
 *
 * `no_transport` is the one to read carefully. It is not an error: it means the channel has no
 * configured way to send, which the estate explicitly supports (an SMTP-less deployment records
 * the request and an operator acts on it). It is therefore **not retryable** — retrying cannot
 * conjure a transport — and it lands the delivery in `undeliverable`, retained, countable, and
 * visible in the dead-letter view.
 *
 * `quota_exhausted` is the one that had to be added. Read its entry below and `email.ts`'s
 * `classify` together; the pair is the whole of micro-org#243's remaining half.
 */
export const FAILURE_REASONS = [
  'no_transport',
  'no_address',
  'invalid_payload',
  'rejected',
  'timeout',
  'upstream_error',
  /**
   * The mail provider refused because this deployment has sent its allowance, not because
   * anything is wrong with the message, the address or the credentials.
   *
   * ## Why this is not `upstream_error`
   *
   * It was, until 2026-08-09, and being indistinguishable from every other upstream failure is
   * what made micro-org#243 take three wrong diagnoses to trace. The estate's provider answers an
   * exhausted allowance with
   *
   *     535 5.7.8 Your account has reached its daily sending limit ... retry in 19m21s
   *
   * so the only thing an operator saw was `notify_failed_total{reason="upstream_error"}` and a
   * `last_error` reading `SMTP 535` — a 5xx AUTH code, which reads as "the password is wrong".
   * Two people concluded exactly that; the mainnet relay was authenticated and externally
   * deliverable the whole time, SPF, DKIM and DMARC all passing.
   *
   * A reason of its own gives the fact a series and a word: an exhausted allowance says so in the
   * counter label, in `deliveries.reason`, in the `outcome` column and in one log line.
   *
   * ## It is retryable, and it does not spend an attempt
   *
   * See `markDeliveryFailed` in `store.ts`. A daily allowance returns on the provider's clock,
   * measured in hours; `deliveries.max_attempts` is 6 and the shared backoff tops out at five
   * minutes, so before this reason existed the six attempts were spent in under a minute and the
   * message was dead-lettered by a condition that would have cleared on its own.
   */
  'quota_exhausted',

  /**
   * The address is under a domain the standards reserve, so no mail exchanger for it can exist.
   *
   * ## Why this is not `rejected`
   *
   * It was, and `rejected` is written by five different call sites: a push gateway answering 4xx,
   * a webhook endpoint answering 410, a webhook endpoint answering anything else, an SMTP 5xx, and
   * this. An operator alerting on the one that matters could not select it, and the one that
   * matters is the only one of the five that should be **impossible**.
   *
   * `pipeline.ts` declines to route email to a reserved domain, so nothing reaches the adapter's
   * guard on the live path. The guard firing therefore means the routing rule was bypassed — a
   * delivery row written before the rule shipped, a caller building an `OutboundMessage` some
   * other way, or a build that lost `reserved.ts`. That third case is the one with teeth: measured
   * on mainnet 2026-08-11, 1,535 of 1,552 email deliveries in seven days went to `beacon.test`
   * because the running process predated the rule, and the only reason anyone noticed was a
   * provider dashboard reading 241 against a 150/day allowance. micro-org#390.
   *
   * So this reason exists to be alerted on at **greater than zero**, which is a threshold no other
   * failure reason here can carry.
   *
   * Not retryable, for the same reason `no_transport` is not: no number of attempts makes
   * `beacon.test` resolvable, and each attempt is a unit of an allowance real recipients share.
   */
  'reserved_domain',
] as const

export type FailureReason = (typeof FAILURE_REASONS)[number]

/**
 * Delivery states.
 *
 *   `pending`       — due now or waiting out a backoff. The only claimable state.
 *   `sent`          — the adapter accepted it.
 *   `dead`          — the attempt budget is spent. Retained: the row is the only durable record
 *                     that this was requested and never done.
 *   `undeliverable` — permanently not sendable for a non-error reason, `no_transport` above all.
 *
 * There is no `failed` terminal state. A retryable failure stays `pending` with a later
 * `next_attempt_at`, because a state that means "failed but will be retried" is a state two
 * queries will disagree about.
 */
export const DELIVERY_STATES = ['pending', 'sent', 'dead', 'undeliverable'] as const

export type DeliveryState = (typeof DELIVERY_STATES)[number]

/**
 * Locales.
 *
 * The seam, not the translation. Templates are keyed by locale with `en-GB` required, and
 * `resolveLocale` falls back to it. Adding a locale is adding a key to each template and a string
 * to this array — no call site changes, which is the whole reason the seam is here before there
 * is a second language rather than after.
 */
export const LOCALES = ['en-GB'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en-GB'

const LOCALE_SET: ReadonlySet<string> = new Set(LOCALES)

export function isLocale(value: string): value is Locale {
  return LOCALE_SET.has(value)
}

/**
 * Pick a locale for a notification.
 *
 * An unknown or absent locale falls back rather than failing. A notification withheld because the
 * platform does not speak the user's language is worse than one sent in British English, and for
 * a critical notification it would breach §10.3 outright.
 */
export function resolveLocale(requested: string | null | undefined): Locale {
  if (typeof requested === 'string' && isLocale(requested)) return requested
  return DEFAULT_LOCALE
}

/** A SQL `in (…)` list, so the database constraint and the type share one source. */
export function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}
