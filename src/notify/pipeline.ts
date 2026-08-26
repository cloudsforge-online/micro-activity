/**
 * The pipeline: event in, notification out, delivery attempted, retried, batched or buried.
 *
 * Four operations, and they are all the same shape underneath — which is the design constraint
 * AD-08 sets and this file honours:
 *
 *   `ingestEvent`      — a domain event becomes notifications for its recipients.
 *   `dispatchDue`      — pending deliveries are leased, sent, and either completed, backed off,
 *                        dead-lettered or marked undeliverable.
 *   `flushDueDigests`  — a batch whose window has passed becomes one summary delivery.
 *   `fanOutBroadcast`  — an operator's message becomes one notification per reachable user.
 *
 * There is one delivery path. An email, a push, an SMS and a developer webhook are the same row
 * in the same table, claimed by the same query, retried with the same backoff, and buried in the
 * same dead-letter view. That is not tidiness; it is the difference between one retry policy that
 * is tested and two that drift.
 *
 * ## Activity and notify are not a chain
 *
 * AD-11 gives the canonical feed to `activity`, and both services consume the same stream. This
 * file never calls activity, never waits for it and never checks whether it succeeded. A
 * notification blocked on a feed write is a security alert that does not arrive because a feed
 * was slow, and §10.3 does not have an exception for that.
 */

import { backoffFor } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  ERASURE_TOPICS,
  outcomeOf,
  ruleFor,
  type Recipient,
  type RecipientSet,
  type Rule,
} from './catalogue.ts'
import type { AdapterRegistry, OutboundMessage } from './channels.ts'
import type { InboundEvent } from './events.ts'
import {
  DEADLETTER_TOTAL,
  DELIVERY_LATENCY_MS,
  FAILED_TOTAL,
  NOTIFICATIONS_TOTAL,
  SENT_TOTAL,
  SUPPRESSED_TOTAL,
} from './metrics.ts'
import {
  FLOOR_CHANNEL,
  resolveLocale,
  type Cadence,
  type Category,
  type Channel,
  type Locale,
  type Priority,
  type SuppressionReason,
} from './model.ts'
import {
  nextDigestWindow,
  periodName,
  resolveRouting,
  type Route,
  type Routing,
} from './routing.ts'
import {
  claimDeliveries,
  deliveriesFor,
  eraseUser,
  getBroadcast,
  insertDeliveries,
  insertNotification,
  joinDigest,
  learnTarget,
  listPreferences,
  markBroadcastFannedOut,
  markDeliveryFailed,
  markDeliverySent,
  markDigestFlushed,
  dueDigests,
  reachableUsers,
  targetsFor,
  withInbox,
  type ChannelTarget,
  type Db,
  type Tx,
} from './store.ts'
import { isUndeliverableAddress } from './reserved.ts'
import {
  isTemplateId,
  renderTemplate,
  templateFor,
  type Template,
  type TemplateId,
} from './templates.ts'

export interface PipelineDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly adapters: AdapterRegistry
  /** `NOTIFY_PUBLIC_URL`. Never a request's Host header — see `env.ts`. */
  readonly publicUrl: string
  readonly maxAttempts: number
  readonly instanceId: string
  /**
   * Whether this deployment has a mail transport at all — `smtpConfigured(env.smtp)`.
   *
   * Required rather than optional, and that is the point of it. An optional flag defaulting to
   * false would let a future composition root omit it and silently switch off the one signal that
   * says mail is reaching nobody, which is the exact class of defect this field exists to report.
   * Read only to decide whether a missing address is worth counting: an SMTP-less deployment is a
   * supported way to run (`email.ts`), and putting a permanent non-zero rate on the series an
   * operator alerts on is how a signal becomes wallpaper.
   */
  readonly emailConfigured: boolean
  /** Test seams. Production passes neither. */
  readonly now?: () => Date
  readonly backoff?: (attempt: number) => number
  readonly leaseMs?: number
}

const clockOf = (deps: PipelineDeps): Date => (deps.now ? deps.now() : new Date())

/* ------------------------------------------------------------------ creating a notification */

export interface NotificationRequest {
  readonly userId: string
  readonly category: Category
  readonly priority: Priority
  readonly templateId: TemplateId
  readonly params: Record<string, unknown>
  readonly dedupeKey: string | null
  readonly subjectUrn: string | null
  readonly locale: Locale
  readonly sourceTopic: string | null
  readonly sourceEventId: string | null
  readonly correlationId: string | null
  /**
   * The estate whose event asked for this, or `null` where nothing said.
   *
   * Recorded on the DELIVERY rather than routed to a second pipeline: notify keeps one SMTP
   * allowance, one dead-letter view and one place to look when a user says they got nothing. What
   * differs between the estates is which event fired, and that is a property of the row. See
   * micro-deploy `docs/network-consolidation.md`.
   */
  readonly network?: string | null | undefined
}

export type CreateOutcome =
  | { readonly kind: 'created'; readonly notificationId: string; readonly routes: readonly Route[] }
  | { readonly kind: 'suppressed'; readonly reason: SuppressionReason }

/**
 * Route, write the notification, and write the deliveries — all in the caller's transaction.
 *
 * The ordering is the substance. Routing happens **before** the insert, because
 * `notifications.channel_count` carries a CHECK that a critical notification reached at least one
 * channel: the database cannot enforce §10.3 unless the count is known at insert time. Writing
 * the row first and updating the count afterwards would leave a window in which a critical
 * notification legally exists with no channels, and windows like that are what a crash finds.
 */
export async function createNotification(
  tx: Tx,
  deps: PipelineDeps,
  request: NotificationRequest,
): Promise<CreateOutcome> {
  const template = templateFor(request.templateId)
  const targets = await targetsFor(tx, request.userId)
  const preferences = await listPreferences(tx, request.userId)
  const available = channelsAvailable(targets, template.deliverOn ?? null)

  const routing = deliverNow(
    template,
    resolveRouting({
      priority: request.priority,
      category: request.category,
      availableChannels: available,
      preferences,
    }),
  )

  if (routing.kind === 'suppressed') {
    // Recorded, not discarded. A user asking "why did I not get told" needs a row that says so,
    // and the preference page needs to be able to show what it is currently hiding.
    await insertNotification(tx, {
      ...request,
      channelCount: 0,
      suppressedReason: routing.reason,
    })
    deps.metrics.increment(SUPPRESSED_TOTAL, { reason: routing.reason })
    return { kind: 'suppressed', reason: routing.reason }
  }

  const notification = await insertNotification(tx, {
    ...request,
    channelCount: routing.routes.length,
    suppressedReason: null,
  })
  if (!notification) {
    // The unique index on (user_id, dedupe_key) won. Another event already described this fact.
    deps.metrics.increment(SUPPRESSED_TOTAL, { reason: 'duplicate' })
    return { kind: 'suppressed', reason: 'duplicate' }
  }

  const instant = deliveriesFor(
    notification.id,
    request.userId,
    routing.routes,
    targets,
    deps.maxAttempts,
    request.network ?? null,
  )
  await insertDeliveries(tx, instant)

  const now = clockOf(deps)
  for (const route of routing.routes) {
    if (route.when === 'instant') continue
    await joinDigest(tx, {
      userId: request.userId,
      channel: route.channel,
      cadence: route.when,
      scheduledFor: nextDigestWindow(route.when, now),
      notificationId: notification.id,
    })
  }

  // After the insert, so it counts notifications that were actually written and actually routed.
  // Reporting before the routing decision would have counted a notification the user's preferences
  // suppressed anyway, and — far worse — one per user per re-run of a broadcast fan-out, which is a
  // job that is retried on crash. The series would then be dominated by re-runs rather than by mail
  // failing to arrive, which is the way this signal would have become wallpaper.
  reportUnaddressed(deps, request, template, available, targets)

  deps.metrics.increment(NOTIFICATIONS_TOTAL, {
    category: request.category,
    priority: request.priority,
  })
  return { kind: 'created', notificationId: notification.id, routes: routing.routes }
}

/**
 * Which channels this user can be reached on, for this notification.
 *
 * The floor channel is unconditional; everything else needs an address. Routing to a channel with
 * no address would create a delivery that can only ever fail `no_address`, which is noise in the
 * dead-letter view rather than information about anything — the argument `routing.ts` makes at
 * length, and the reason the absence is reported as a counter instead (see `reportUnaddressed`).
 *
 * `allowed` is a template's `deliverOn`, absent for all but one template today. It narrows the
 * candidates and never widens them, and it cannot remove the floor channel — §10.3 rests on
 * `in_app` being available unconditionally, and a template restriction is a statement about where a
 * message makes sense, not a licence to route a critical notification to nothing.
 */
function channelsAvailable(
  targets: readonly ChannelTarget[],
  allowed: readonly Channel[] | null,
): Channel[] {
  const channels = new Set<Channel>([FLOOR_CHANNEL])
  for (const target of targets) {
    if (allowed !== null && !allowed.includes(target.channel)) continue
    // An address under a reserved domain has no mail exchanger and never will (see `reserved.ts`).
    // Skipping it HERE rather than in the adapter is the load-bearing part: the route is never
    // taken, so no delivery row is written, nothing is retried six times, and nothing is
    // dead-lettered. The adapter keeps its own guard as a backstop for a row written before this
    // shipped, but on the live path this line is what stops the allowance being spent.
    if (target.channel === 'email' && isUndeliverableAddress(target.address)) continue
    channels.add(target.channel)
  }
  return [...channels]
}

/**
 * The canary address the self-check below routes. Reserved by RFC 6761 §6, so it can never resolve.
 *
 * It is not `beacon.test` on purpose. The rule this proves is about the standards and not about the
 * monitor's chosen name (see `reserved.ts`), and a canary spelled `beacon.test` would go on passing
 * for a build whose rule had been narrowed to a deny-list — which is the exact regression the rule
 * is written the way it is to prevent.
 */
export const GUARD_CANARY_ADDRESS = 'reserved-domain-canary@cf-guard-canary.invalid'

/**
 * Does the RUNNING build still refuse to route email to a reserved domain?
 *
 * ## Why a metric and not a test
 *
 * `reserved.test.ts` proves the rule is correct in the tree. It says nothing about the process
 * answering on port 4108, and that gap is the whole of micro-org#390: the rule had been merged
 * since 2.4.0, was verified in CI, was verified on testnet — and the mainnet `notify` process was
 * an older image that did not contain it. It sent 1,535 messages to `beacon.test` over six days,
 * emptied a 150/day allowance, and no signal anywhere said so. The estate found out from the
 * provider's dashboard.
 *
 * The alert that shipped first (`MailSentToReservedDomain`) watches
 * `notify_failed_total{reason="reserved_domain"}` — the backstop in `email.ts`. Measured on mainnet
 * on 2026-08-11 that counter is **zero over seven days**, and it is zero for a good reason: the
 * routing rule below drops the channel before a delivery row is written, so on the live path
 * nothing ever reaches the backstop. A build that lost the rule ENTIRELY loses the backstop with
 * it — nothing increments, and the one alert that exists cannot fire in precisely the case it was
 * written for. It detects half a regression and is silent for the whole one.
 *
 * ## What this does instead
 *
 * It drives `channelsAvailable` — the real routing decision, not `isUndeliverableAddress` in
 * isolation — with a synthetic target under a reserved domain, and reports whether `email` came
 * back. Calling the routing function rather than the predicate is the load-bearing part: deleting
 * the `continue` above leaves `reserved.ts` untouched and every one of its unit tests green, and
 * this is the check that goes red for it.
 *
 * `true` means the running process refuses. `false` means it would route mail to an address that
 * cannot exist, and the allowance starts draining on the next notification. The gauge derived from
 * it is `notify_reserved_domain_guard`, and it is answered at every scrape — so a build that lost
 * the rule is identified within one scrape interval, before any mail is sent, rather than six days
 * later from a billing page.
 *
 * Pure, allocates two small objects, and touches no database: cheap enough to answer on the scrape
 * path, which is where it has to be answered. A boot-time check would report the build that booted
 * and go on reporting it after a rolling replacement put a different one behind the same name.
 */
export function reservedDomainGuardIntact(): boolean {
  const canary: ChannelTarget = {
    id: '00000000-0000-4000-8000-000000000000',
    channel: 'email',
    address: GUARD_CANARY_ADDRESS,
    secret: null,
    label: null,
  }
  return !channelsAvailable([canary], null).includes('email')
}

/**
 * A single-use credential is delivered now, whatever cadence the reader asked for.
 *
 * ## The failure this exists to stop, which every other guard is quiet about
 *
 * A user with `digest: 'daily'` on their account preferences asks for a verification link. Nothing
 * complains: the address is on file, so `reportUnaddressed` is silent; `deliverOn` picks the right
 * channel; the routing is legal; the notification is written. But `deliveriesFor` writes a delivery
 * only for an `instant` route, and `flushDueDigests` renders a batched item through `describe()`,
 * which substitutes the SUBJECT and nothing else — so the link is never rendered anywhere at all.
 * It is redacted out of every HTTP response as well, by design. The reader gets a summary the next
 * morning saying they were asked to confirm their address, and no way to do it, for ever.
 *
 * ## Why it is derived from `secretParams` rather than declared again
 *
 * A second opt-in field is a second thing to forget, and forgetting it is silent. The two properties
 * are the same property: a value that must be redacted out of every read route is one the reader can
 * only ever act on through the message itself, so a copy of that message which drops the value is
 * not a delayed delivery — it is no delivery. Batching one is meaningless in every case, which is
 * exactly when the rule belongs in the mechanism instead of in a field.
 *
 * The preference is not overridden in any way the user would notice as a loss: they asked for their
 * account mail in a daily batch and this is not batchable, so it arrives on its own. Nothing is
 * suppressed, no channel is added, and a channel the preference filter removed stays removed.
 */
function deliverNow(template: Template, routing: Routing): Routing {
  if (routing.kind !== 'deliver') return routing
  if (!template.secretParams || template.secretParams.length === 0) return routing
  const [first, ...rest] = routing.routes.map((route): Route => ({ channel: route.channel, when: 'instant' }))
  if (!first) return routing
  return { kind: 'deliver', routes: [first, ...rest] }
}

/**
 * Say when a working mailer is about to reach nobody.
 *
 * ## The defect this closes
 *
 * A user with no `email` target is not routed to email at all, so no delivery row is written, so
 * nothing appears in `GET /admin/deliveries`, nothing is logged and nothing is counted. That is
 * correct behaviour for a deployment with no SMTP — `no_transport` is the honest reading and
 * `email.ts` argues for it — and it is a **silent failure** on a deployment whose transport works,
 * which is what the estate has been running: eight `SMTP_*` variables set, `notify` healthy, and
 * not one user in the database with an address to send to. From outside, mail simply never arrived
 * and no dashboard in the estate had a number that moved.
 *
 * ## Why it reuses `notify_failed_total` rather than minting a series
 *
 * The question an operator has is "how much mail is this deployment failing to send, and why", and
 * it should have one answer. `email.ts` already returns `no_address` when a delivery reaches the
 * adapter without one, counted with exactly these labels at `dispatchDue`. Splitting the same fact
 * across two metric names according to WHERE it was noticed is the drift this service's own
 * comments argue against everywhere else, and an alert written against one of them would be blind
 * to the other — which is the more common case by far.
 *
 * The log line is per notification and is meant to be: on a healthy deployment it is silent, and on
 * this one the volume is the finding. It carries the user id, the category and the template id, and
 * no parameters — a template parameter is arbitrary domain data and one of them is a credential.
 */
function reportUnaddressed(
  deps: PipelineDeps,
  request: NotificationRequest,
  template: Template,
  available: readonly Channel[],
  targets: readonly ChannelTarget[],
): void {
  if (!deps.emailConfigured) return
  if (available.includes('email')) return
  // A template that may not be delivered by email is not failing to be; it was never going.
  if (template.deliverOn && !template.deliverOn.includes('email')) return
  // Nor is an address that cannot exist. `channelsAvailable` drops email for a reserved domain, so
  // without this line every one of the monitor's ~95 registrations an hour would be counted and
  // logged as a user with no address on file — burying the real signal under synthetic volume at
  // roughly ninety to one, which is how a warning becomes wallpaper. Nothing failed here: there was
  // never anybody at the other end.
  if (targets.some((t) => t.channel === 'email' && isUndeliverableAddress(t.address))) return

  deps.metrics.increment(FAILED_TOTAL, { channel: 'email', reason: 'no_address' })
  deps.logger.warn('no email address on file; this notification reaches nobody by mail', {
    userId: request.userId,
    category: request.category,
    templateId: request.templateId,
  })
}

/* ------------------------------------------------------------------ ingest */

export type IngestOutcome =
  | { readonly kind: 'duplicate_event' }
  | { readonly kind: 'erased'; readonly notifications: number }
  | { readonly kind: 'ignored'; readonly reason: SuppressionReason }
  | {
      readonly kind: 'processed'
      readonly created: readonly string[]
      readonly suppressed: readonly SuppressionReason[]
    }

/**
 * Map one inbound event onto notifications.
 *
 * Everything happens inside `withInbox`, so the inbox row, the notifications and the delivery
 * rows commit together. A handler that throws leaves no inbox row and the redelivery is processed
 * rather than swallowed — the property that makes at-least-once delivery safe.
 */
export async function ingestEvent(
  deps: PipelineDeps,
  event: InboundEvent,
  /**
   * The estate the DELIVERING REQUEST came from, stamped onto every delivery this event creates.
   *
   * Optional and defaulting to null, so every existing caller and the digest path — which runs off
   * a timer and has no request to read — keep today's behaviour and write an honest null.
   */
  network: string | null = null,
): Promise<IngestOutcome> {
  const outcome = await withInbox(deps.sql, event.topic, event.id, async (tx) => {
    if (ERASURE_TOPICS.has(event.topic)) {
      const userId =
        typeof event.payload['user_id'] === 'string'
          ? (event.payload['user_id'] as string)
          : event.key
      const removed = await eraseUser(tx, userId)
      deps.logger.info('user erased', { topic: event.topic, notifications: removed })
      return { kind: 'erased', notifications: removed } satisfies IngestOutcome
    }

    const rule = ruleFor(event.topic)
    if (!rule) {
      deps.metrics.increment(SUPPRESSED_TOTAL, { reason: 'no_rule' })
      return { kind: 'ignored', reason: 'no_rule' } satisfies IngestOutcome
    }

    const set = rule.recipients(event)
    if (set.kind === 'none') {
      deps.metrics.increment(SUPPRESSED_TOTAL, { reason: set.reason })
      return { kind: 'ignored', reason: set.reason } satisfies IngestOutcome
    }

    // BEFORE the notifications, and in the same transaction as them. That ordering is the whole
    // repair: the event that carries an address is usually the one that most needs to reach it, so
    // learning the address afterwards would send the very first mail to nobody and only work from
    // the second event onwards — which, for a verification link, means never.
    await learnAddress(tx, deps, rule, event, set)

    // Resolved from the EVENT, not read off the rule: one topic can carry two facts, and
    // `settlement.outbound.failed` is the one that does — `refundable` decides whether this is a
    // critical "your money is held" or a high "it is coming back". See `Variant` in catalogue.ts.
    const outcome = outcomeOf(rule, event)

    const created: string[] = []
    const suppressed: SuppressionReason[] = []
    for (const recipient of set.recipients) {
      const result = await createNotification(
        tx,
        deps,
        requestFor(event, rule.category, outcome.priority, outcome.templateId, recipient, network),
      )
      if (result.kind === 'created') created.push(result.notificationId)
      else suppressed.push(result.reason)
    }
    return { kind: 'processed', created, suppressed } satisfies IngestOutcome
  })

  if (outcome.status === 'duplicate') return { kind: 'duplicate_event' }
  return outcome.value
}

/**
 * Keep the address a rule says this event carries.
 *
 * See `LearnedAddress` in `catalogue.ts` for why this service holds an address at all, and
 * `learnTarget` in `store.ts` for why the user's other addresses on the channel are retired rather
 * than left beside it.
 *
 * **A rule that declares it learns an address, given a payload with none, is reported.** Silence
 * there would be the original defect wearing a new coat: the notification would be written, look
 * perfectly well formed, deliver in-app, and never reach the inbox it was written for — which is
 * exactly what the last year of this service looked like from outside. The address itself is never
 * logged; the topic and the channel are enough to find the producer, and an email address is
 * personal data this service is holding on someone else's behalf.
 */
async function learnAddress(
  tx: Tx,
  deps: PipelineDeps,
  rule: Rule,
  event: InboundEvent,
  set: Extract<RecipientSet, { kind: 'recipients' }>,
): Promise<void> {
  const learns = rule.learns
  if (!learns) return

  const address = learns.read(event)
  if (address === null) {
    // Logged, and deliberately NOT counted here. `reportUnaddressed` fires a moment later for the
    // notification this event is about to produce, because the address it would have needed is the
    // one that did not arrive — so counting in both places would put two increments on one fact and
    // overstate the series an operator alerts on. The log is what says WHICH of the two shapes this
    // is: a producer that stopped sending a field, rather than an account that never had one.
    deps.logger.warn('an event that should have carried an address carried none', {
      topic: event.topic,
      channel: learns.channel,
    })
    return
  }

  // Whose address it is, from the payload — never from the actor, and never "every recipient".
  // A rule with more than one recipient that learned an address would give the whole group one
  // inbox and switch off each of their real ones, which no future rule should be able to do by
  // accident. See `LearnedAddress.subject`.
  const subject = learns.subject(event)
  if (subject === null || !set.recipients.some((recipient) => recipient.userId === subject)) {
    deps.logger.warn('an event carried an address but named nobody it belongs to', {
      topic: event.topic,
      channel: learns.channel,
    })
    return
  }

  await learnTarget(tx, {
    userId: subject,
    channel: learns.channel,
    address,
    // Provenance, in the column an operator reading `channel_targets` by hand will see. It says
    // the platform put this row there rather than the person, which is the difference that
    // matters when somebody asks why they are receiving mail at an address they never gave us.
    label: event.topic,
  })
}

function requestFor(
  event: InboundEvent,
  category: Category,
  priority: Priority,
  templateId: TemplateId,
  recipient: Recipient,
  network: string | null,
): NotificationRequest {
  return {
    userId: recipient.userId,
    category,
    priority,
    templateId,
    params: recipient.params,
    dedupeKey: recipient.dedupeKey,
    subjectUrn: recipient.subjectUrn,
    locale: resolveLocale(
      typeof event.payload['locale'] === 'string' ? (event.payload['locale'] as string) : null,
    ),
    sourceTopic: event.topic,
    sourceEventId: event.id,
    correlationId: event.correlationId,
    network,
  }
}

/* ------------------------------------------------------------------ dispatch */

export interface DispatchSummary {
  readonly claimed: number
  readonly sent: number
  readonly retried: number
  readonly dead: number
  readonly undeliverable: number
}

/**
 * Send whatever is due.
 *
 * One pass. Called from a leased job (`jobs.ts`), never from a timer — rule 8. The lease on each
 * row means two dispatchers running at once is safe rather than merely unlikely.
 *
 * A failing adapter never throws out of here: one dead endpoint must not stop the rest of the
 * batch, and the delivery row is the durable record that the next pass will retry.
 */
export async function dispatchDue(deps: PipelineDeps, limit: number): Promise<DispatchSummary> {
  const leaseMs = deps.leaseMs ?? 60_000
  const backoff = deps.backoff ?? backoffFor
  const claimed = await claimDeliveries(deps.sql, deps.instanceId, limit, leaseMs)

  let sent = 0
  let retried = 0
  let dead = 0
  let undeliverable = 0

  for (const delivery of claimed) {
    const adapter = deps.adapters.get(delivery.channel)
    if (!adapter) {
      // A channel with no adapter registered is the same situation as a channel with no
      // credentials: nothing can send it, and no retry will change that.
      await markDeliveryFailed(deps.sql, delivery.id, {
        reason: 'no_transport',
        retryable: false,
        detail: `no adapter registered for ${delivery.channel}`,
        backoffMs: 0,
      })
      deps.metrics.increment(FAILED_TOTAL, { channel: delivery.channel, reason: 'no_transport' })
      undeliverable += 1
      continue
    }

    const message = messageFor(deps, delivery)
    let outcome
    try {
      outcome = await adapter.send(message)
    } catch (err) {
      // An adapter that throws is an adapter with a bug. Treated as a retryable upstream error
      // rather than allowed to abort the batch, because the alternative is one malformed message
      // stopping every other delivery in the estate.
      outcome = {
        ok: false as const,
        reason: 'upstream_error' as const,
        retryable: true,
        detail: err instanceof Error ? err.message : String(err),
      }
    }

    if (outcome.ok) {
      await markDeliverySent(deps.sql, delivery.id, outcome.providerRef ?? null)
      deps.metrics.increment(SENT_TOTAL, { channel: delivery.channel, category: delivery.category })
      deps.metrics.observe(
        DELIVERY_LATENCY_MS,
        Math.max(0, clockOf(deps).getTime() - Date.parse(delivery.notificationCreatedAt)),
      )
      sent += 1
      continue
    }

    // The provider's allowance is not this message's fault, so it neither spends this message's
    // attempt budget nor waits on a backoff derived from it — see `markDeliveryFailed` in
    // `store.ts` and `QUOTA_RETRY_FLOOR_MS` in `email.ts`. micro-org#243.
    const outOfAllowance = outcome.reason === 'quota_exhausted'

    const state = await markDeliveryFailed(deps.sql, delivery.id, {
      reason: outcome.reason,
      retryable: outcome.retryable,
      detail: outcome.detail,
      // A provider that stated its own retry-after is obeyed. Nothing but the mail adapter sets
      // this today, and a channel that never states one is unaffected.
      backoffMs: outcome.retryAfterMs ?? backoff(delivery.attempts),
      consumesAttempt: !outOfAllowance,
    })
    deps.metrics.increment(FAILED_TOTAL, { channel: delivery.channel, reason: outcome.reason })

    if (outOfAllowance) {
      // ── SAID PLAINLY, ONCE PER REFUSAL. ────────────────────────────────────────────────────
      //
      // This log line is a deliverable of micro-org#243 rather than debugging left in. The
      // condition it reports spent 1,839 sends on 2026-08-07 and was diagnosed, in order, as
      // broken SMTP credentials, a misconfigured public URL and an agent run — because the only
      // thing it had ever said was `535`. It now says what it is, and says what it is not.
      //
      // `warn`, not `error`. Mail is queued, not lost: the delivery is parked and goes out when
      // the allowance resets, which is the outcome, not a failure. It becomes an error the moment
      // it dead-letters, and the branch below already logs that.
      deps.logger.warn("the mail provider's sending allowance is exhausted", {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        category: delivery.category,
        // Named so nobody re-derives it a fourth time. The provider answers this condition with a
        // 5xx AUTH code, and a 5xx AUTH code is what a credential failure looks like.
        note: 'not a credentials failure and not an attacker; the plan allowance is spent',
        retryAfterMs: outcome.retryAfterMs ?? null,
        // A parked delivery does not move towards dead-lettering, so this is the number that says
        // how long it has genuinely been trying rather than how long the allowance has been gone.
        attempts: delivery.attempts,
      })
    }

    if (state === 'dead') {
      deps.metrics.increment(DEADLETTER_TOTAL)
      dead += 1
      // Logged at error because a dead delivery is work that was requested and never done. The
      // notification id is here so an operator can find what was not said; the body is not.
      deps.logger.error('delivery dead-lettered', {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        reason: outcome.reason,
        attempts: delivery.attempts,
      })
    } else if (state === 'undeliverable') {
      undeliverable += 1
      // Info, not error. `no_transport` on a deployment with no SMTP is a configuration choice.
      deps.logger.info('delivery undeliverable', {
        deliveryId: delivery.id,
        channel: delivery.channel,
        reason: outcome.reason,
      })
    } else {
      retried += 1
    }
  }

  return { claimed: claimed.length, sent, retried, dead, undeliverable }
}

/**
 * Build the message an adapter sends.
 *
 * A delivery whose template no longer exists renders as its own template id rather than throwing.
 * A template can be removed by a deploy while deliveries referencing it are still pending, and
 * the correct answer to that is a slightly ugly notification, not a poisoned queue.
 */
function messageFor(
  deps: PipelineDeps,
  delivery: {
    id: string
    notificationId: string
    userId: string
    channel: Channel
    address: string | null
    secret: string | null
    category: Category
    priority: Priority
    templateId: string
    params: Record<string, unknown>
    locale: Locale
    notificationCreatedAt: string
  },
): OutboundMessage {
  const template = isTemplateId(delivery.templateId) ? templateFor(delivery.templateId) : null
  const rendered = template
    ? renderTemplate(template, delivery.params, delivery.locale, deps.publicUrl)
    : {
        subject: delivery.templateId,
        body: delivery.templateId,
        link: deps.publicUrl,
        missing: [] as readonly string[],
      }

  if (rendered.missing.length > 0) {
    // Names only. A template parameter is arbitrary domain data — an address, an amount, a device
    // — and the estate has already been burned once by putting a live credential in a log line.
    deps.logger.warn('template parameters missing', {
      templateId: delivery.templateId,
      missing: rendered.missing,
    })
  }

  return {
    deliveryId: delivery.id,
    notificationId: delivery.notificationId,
    userId: delivery.userId,
    channel: delivery.channel,
    category: delivery.category,
    priority: delivery.priority,
    templateId: delivery.templateId,
    address: delivery.address,
    secret: delivery.secret,
    subject: rendered.subject,
    body: rendered.body,
    link: rendered.link,
    params: delivery.params,
    createdAt: delivery.notificationCreatedAt,
  }
}

/* ------------------------------------------------------------------ digests */

export interface DigestSummary {
  readonly flushed: number
  readonly notifications: number
}

/**
 * Turn every batch whose window has passed into one delivery.
 *
 * The summary is itself a notification, with its own dedupe key derived from the digest id — so a
 * flush that is retried after a crash produces the same row rather than a second summary. Its
 * priority is `low` and its category `system`, because a digest is by definition the thing the
 * user asked not to be interrupted by.
 */
export async function flushDueDigests(
  deps: PipelineDeps,
  limit: number,
): Promise<DigestSummary> {
  const now = clockOf(deps)
  const due = await dueDigests(deps.sql, now, limit)
  let notifications = 0

  for (const digest of due) {
    if (digest.items.length > 0) {
      await deps.sql.begin(async (tx) => {
        const summary = await insertNotification(tx, {
          userId: digest.userId,
          category: 'system',
          priority: 'low',
          templateId: 'digest.summary',
          params: {
            count: digest.items.length,
            period: periodName(digest.cadence),
            items: digest.items.map((item) => `• ${describe(item.templateId, item.params)}`).join('\n'),
          },
          locale: digest.items[0]?.locale ?? 'en-GB',
          // Derived from the digest id, so a retried flush is idempotent.
          dedupeKey: `digest:${digest.id}`,
          subjectUrn: null,
          sourceTopic: null,
          sourceEventId: null,
          correlationId: null,
          channelCount: 1,
          suppressedReason: null,
        })
        if (!summary) return
        // Delivered on the channel whose preference asked for the digest, not re-routed: the user
        // said "batch my email", so the batch goes by email.
        const targets = (await targetsFor(tx, digest.userId)).filter(
          (target) => target.channel === digest.channel,
        )
        await insertDeliveries(
          tx,
          deliveriesFor(
            summary.id,
            digest.userId,
            [{ channel: digest.channel, when: 'instant' }],
            targets,
            deps.maxAttempts,
          ),
        )
        notifications += 1
      })
    }
    await markDigestFlushed(deps.sql, digest.id)
  }

  return { flushed: due.length, notifications }
}

/** One line per batched notification. Subjects, not bodies: a digest is an index, not a reprint. */
function describe(templateId: string, params: Record<string, unknown>): string {
  if (!isTemplateId(templateId)) return templateId
  const template = templateFor(templateId)
  const text = template.text['en-GB']
  return text.subject.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

/* ------------------------------------------------------------------ broadcasts */

export interface BroadcastSummary {
  readonly recipients: number
  readonly created: number
}

/**
 * Fan an operator broadcast out to every reachable user.
 *
 * Paged by user id so a broadcast to a large estate is a sequence of bounded transactions rather
 * than one that holds a snapshot open for minutes. Each user's notification goes through
 * `createNotification`, which means a broadcast respects preferences exactly as an event-driven
 * notification does — including the §10.3 exception if an operator sends one at `critical`.
 */
export async function fanOutBroadcast(
  deps: PipelineDeps,
  broadcastId: string,
  pageSize = 200,
): Promise<BroadcastSummary> {
  const broadcast = await getBroadcast(deps.sql, broadcastId)
  if (!broadcast) throw new Error(`no broadcast ${broadcastId}`)
  if (!isTemplateId(broadcast.templateId)) {
    throw new Error(`broadcast ${broadcastId} names an unknown template`)
  }
  const templateId: TemplateId = broadcast.templateId

  let recipients = 0
  let created = 0
  let after: string | null = null

  for (;;) {
    const users: string[] =
      broadcast.audience === 'listed'
        ? [...broadcast.userIds].filter((id) => after === null || id > after).sort().slice(0, pageSize)
        : await reachableUsers(deps.sql, pageSize, after)
    if (users.length === 0) break

    await deps.sql.begin(async (tx) => {
      for (const userId of users) {
        const result = await createNotification(tx, deps, {
          userId,
          category: broadcast.category,
          priority: broadcast.priority,
          templateId,
          params: broadcast.params,
          // One per user per broadcast. A re-run of the fan-out after a crash produces nothing
          // new, which is what makes this job safe to retry.
          dedupeKey: broadcast.dedupeKey,
          subjectUrn: `cf:notify:broadcast:${broadcast.id}`,
          locale: 'en-GB',
          sourceTopic: null,
          sourceEventId: null,
          correlationId: broadcast.id,
        })
        recipients += 1
        if (result.kind === 'created') created += 1
      }
    })

    after = users[users.length - 1] ?? null
    if (users.length < pageSize) break
  }

  await markBroadcastFannedOut(deps.sql, broadcastId, recipients)
  return { recipients, created }
}

/** Re-exported so `jobs.ts` and the tests share one spelling of the cadence type. */
export type { Cadence }
