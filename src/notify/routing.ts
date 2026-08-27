/**
 * Which channels a notification goes to, and when.
 *
 * This is the smallest and most important module in the service. It is pure — no database, no
 * clock beyond what is passed in, no I/O — so the invariant it carries can be tested exhaustively
 * rather than through a delivery pipeline.
 *
 * ## The invariant
 *
 * 04-domain-model §10.3: *`critical` security notifications ignore preferences and always send on
 * at least one channel. A user cannot opt out of being told their key left.*
 *
 * Read `resolveRouting` below and notice what is **not** there: on the critical path, the
 * `preferences` argument is never read. Not read and then overridden — never read. That is
 * deliberate. An override is a line of code that can be made conditional by a well-meaning change
 * ("except when the user has explicitly confirmed…"), whereas a branch that never consults the
 * data cannot be softened without deleting the branch.
 *
 * Three further guards, each independent:
 *
 *   - `applyPreferences` takes `NonCriticalPriority`. Passing a critical notification to the
 *     preference filter is a **compile error**.
 *   - The `deliver` outcome carries a non-empty tuple, so "routed to nothing" has no
 *     representation in the type.
 *   - `migrations.ts` puts two CHECK constraints on `notifications` so the database refuses a
 *     critical row that is suppressed or that reached no channel.
 *
 * ## Why in-app is the floor
 *
 * "At least one channel" is only a guarantee if one channel cannot fail for configuration
 * reasons. In-app needs no address, no credential and no third party — the notification row
 * itself is the delivery, readable at `GET /notifications` the instant it is written. Every other
 * channel can be `undeliverable_no_transport`; in-app never can. So the guarantee is unconditional
 * even on a deployment with no SMTP, no push gateway and no phone number on file.
 */

import {
  CRITICAL_CHANNEL_ORDER,
  FLOOR_CHANNEL,
  PRIORITY_RANK,
  type Cadence,
  type Category,
  type Channel,
  type Digest,
  type NonCriticalPriority,
  type Priority,
  type SuppressionReason,
} from './model.ts'

/** A preference row as this module needs it. `(user, category, channel)` — 04-domain-model §10.3. */
export interface Preference {
  readonly category: Category
  readonly channel: Channel
  readonly enabled: boolean
  readonly digest: Digest
  readonly minPriority: Priority
}

/**
 * What a user gets when they have expressed no preference for a channel.
 *
 * Opt-out rather than opt-in, and `low` rather than something higher, because the alternative is
 * a platform that holds someone's money and tells them nothing until they find the settings page.
 * A user who does not want it can say so; a user who never knew is not protected by silence.
 */
export const DEFAULT_PREFERENCE: Omit<Preference, 'category' | 'channel'> = Object.freeze({
  enabled: true,
  digest: 'instant',
  minPriority: 'low',
})

export interface Route {
  readonly channel: Channel
  /** `instant` produces a delivery row now; a cadence joins the user's open digest batch. */
  readonly when: 'instant' | Cadence
}

export type Routing =
  | { readonly kind: 'deliver'; readonly routes: readonly [Route, ...Route[]] }
  | { readonly kind: 'suppressed'; readonly reason: SuppressionReason }

export interface RoutingInput {
  readonly priority: Priority
  readonly category: Category
  /**
   * Channels this user can actually be reached on: `in_app`, plus one per active target row.
   * A channel with no address is not a candidate — routing to it would create a delivery that can
   * only ever fail `no_address`, which is noise in the dead-letter view rather than information.
   */
  readonly availableChannels: readonly Channel[]
  readonly preferences: readonly Preference[]
}

/**
 * Decide where a notification goes.
 *
 * The critical branch is first and is total: it returns before `input.preferences` is touched.
 */
export function resolveRouting(input: RoutingInput): Routing {
  const available = candidates(input.availableChannels)

  if (input.priority === 'critical') {
    // No preference lookup. See the header. The user's settings are not consulted, so there is
    // nothing here for a future change to make conditional.
    const ordered = CRITICAL_CHANNEL_ORDER.filter((channel) => available.has(channel))
    const routes = ordered.map((channel): Route => ({ channel, when: 'instant' }))
    const [first, ...rest] = routes
    // `first` is always present because `candidates` guarantees the floor channel. The throw is
    // unreachable and stays as an assertion rather than a cast: if it ever fires, §10.3 has been
    // broken by an edit and this service should say so rather than deliver nothing.
    if (!first) throw new Error('critical notification resolved to no channel; §10.3 is broken')
    return { kind: 'deliver', routes: [first, ...rest] }
  }

  return applyPreferences(input.priority, input.category, available, input.preferences)
}

/**
 * The preference filter.
 *
 * Its `priority` parameter is `NonCriticalPriority`, which is the type-level half of the
 * invariant: this function cannot be called with a critical notification, so it cannot suppress
 * one — not by accident, not by a refactor, not by someone reading only this file.
 */
export function applyPreferences(
  priority: NonCriticalPriority,
  category: Category,
  available: ReadonlySet<Channel>,
  preferences: readonly Preference[],
): Routing {
  const byChannel = new Map<Channel, Preference>()
  for (const preference of preferences) {
    if (preference.category === category) byChannel.set(preference.channel, preference)
  }

  const routes: Route[] = []
  // Counted so the suppression reason can name the actual cause rather than a generic one. An
  // operator asking "why did this user not get it" needs "they turned that category off", not
  // "preferences".
  const reasons = { channel_disabled: 0, below_min_priority: 0, digest_off: 0 }

  for (const channel of available) {
    const preference = byChannel.get(channel) ?? { category, channel, ...DEFAULT_PREFERENCE }
    if (!preference.enabled) {
      reasons.channel_disabled += 1
      continue
    }
    if (PRIORITY_RANK[priority] < PRIORITY_RANK[preference.minPriority]) {
      reasons.below_min_priority += 1
      continue
    }
    if (preference.digest === 'off') {
      reasons.digest_off += 1
      continue
    }
    routes.push({ channel, when: preference.digest === 'instant' ? 'instant' : preference.digest })
  }

  const [first, ...rest] = routes
  if (first) return { kind: 'deliver', routes: [first, ...rest] }
  return { kind: 'suppressed', reason: dominantReason(reasons) }
}

/**
 * The one reason to record when every channel was filtered out.
 *
 * A single dominant cause is reported when there is one; a genuine mixture reports `preferences`.
 * Reporting the first cause encountered instead would make the metric depend on channel ordering,
 * which is not information.
 */
function dominantReason(counts: {
  channel_disabled: number
  below_min_priority: number
  digest_off: number
}): SuppressionReason {
  const nonZero = (Object.entries(counts) as [SuppressionReason, number][]).filter(([, n]) => n > 0)
  if (nonZero.length === 1) {
    const only = nonZero[0]
    if (only) return only[0]
  }
  return 'preferences'
}

/** The floor channel is always a candidate, whatever the caller passed. */
function candidates(available: readonly Channel[]): ReadonlySet<Channel> {
  const set = new Set<Channel>(available)
  set.add(FLOOR_CHANNEL)
  return set
}

/**
 * When a digest batch for `cadence` should fire, given the moment a notification joined it.
 *
 * Aligned to the wall clock rather than to "an hour from the first item", so every user's hourly
 * digest fires on the hour. Two reasons, and the second is the one that matters: a per-user
 * offset means the flush job has no natural batch to claim and degrades into one query per user,
 * and an aligned boundary is a thing an operator can reason about when a digest is late.
 *
 * Daily fires at 09:00 UTC. A daily digest delivered at 03:00 because that is when the first item
 * arrived is a notification that wakes somebody up, which is the opposite of what `daily` means.
 */
export function nextDigestWindow(cadence: Cadence, now: Date): Date {
  if (cadence === 'hourly') {
    const at = new Date(now)
    at.setUTCMinutes(0, 0, 0)
    at.setUTCHours(at.getUTCHours() + 1)
    return at
  }
  const at = new Date(now)
  at.setUTCMinutes(0, 0, 0)
  at.setUTCHours(DAILY_DIGEST_HOUR_UTC)
  if (at.getTime() <= now.getTime()) at.setUTCDate(at.getUTCDate() + 1)
  return at
}

export const DAILY_DIGEST_HOUR_UTC = 9

/** `hourly` → "hour", for the digest template. British English, no abbreviations. */
export function periodName(cadence: Cadence): string {
  return cadence === 'hourly' ? 'hour' : 'day'
}

/** Convenience for tests and for the admin view: is this priority one a user cannot mute? */
export function isUnmutable(priority: Priority): boolean {
  return priority === 'critical'
}
