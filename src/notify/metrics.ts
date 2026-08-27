/**
 * The domain metrics, declared rather than inferred from a log line.
 *
 * AD-20: a service declares `ledger_postings_total` rather than inventing a log line to grep. The
 * alternative breaks when someone rewords a message and cannot be a Prometheus counter with
 * labels.
 *
 * Every label set here is closed — a fixed list from `model.ts`, never a user id, a template
 * parameter, a topic taken from a request or an error string. An unbounded label is how a caller
 * mints unlimited time series and takes the scrape target down, and this service's inputs come
 * from twenty other services.
 */

import { Metrics } from '@cloudsforge/telemetry'

export const SENT_TOTAL = 'notify_sent_total'
export const FAILED_TOTAL = 'notify_failed_total'
export const DELIVERY_LATENCY_MS = 'notify_delivery_latency_ms'
export const DEADLETTER_TOTAL = 'notify_deadletter_total'
export const SUPPRESSED_TOTAL = 'notify_suppressed_total'

export const INGESTED_TOTAL = 'notify_ingested_total'
export const NOTIFICATIONS_TOTAL = 'notify_notifications_total'
export const DELIVERIES_PENDING = 'notify_deliveries_pending'
export const DELIVERIES_DEAD = 'notify_deliveries_dead'
export const DIGESTS_OPEN = 'notify_digests_open'
export const AWAITING_ALLOWANCE = 'notify_deliveries_awaiting_allowance'
export const RESERVED_DOMAIN_GUARD = 'notify_reserved_domain_guard'
export const RESERVED_DOMAIN_DELIVERIES = 'notify_deliveries_reserved_domain'

/**
 * How far back `notify_deliveries_reserved_domain` looks.
 *
 * One hour, and the length is doing two jobs. It has to outlast a scrape gap — a gauge that is only
 * true for the sixty seconds after the row is written can be missed entirely by a Prometheus that
 * fell behind, and an alert that depends on being lucky is not an alert. And it has to be short
 * enough that the alert CLEARS by itself once the leak is fixed, so the next occurrence is a fresh
 * page rather than a series somebody silenced a week ago and stopped reading.
 */
export const RESERVED_DOMAIN_WINDOW_MS = 60 * 60_000

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: SENT_TOTAL,
      help: 'Notifications accepted by a channel adapter',
      kind: 'counter',
      labels: ['channel', 'category'],
    })
    .register({
      name: FAILED_TOTAL,
      // "or could not be attempted" is not padding. `no_address` is raised in two places for one
      // fact: by an adapter handed a delivery with no address, and by `createNotification` when a
      // deployment whose mailer works has nobody to send to — the case that used to produce no
      // delivery row at all and therefore no signal whatsoever. An operator alerting on mail that
      // is not going out needs one series for both, not one per place the gap was noticed.
      help: 'Deliveries that failed, or could not be attempted at all, by channel and reason',
      kind: 'counter',
      labels: ['channel', 'reason'],
    })
    .register({
      name: DELIVERY_LATENCY_MS,
      help: 'Milliseconds from notification created to delivery accepted',
      kind: 'histogram',
      // Tuned for this service rather than left at the default. The interesting question is "did
      // the security alert arrive within a minute", so the buckets are dense below a minute and
      // sparse above it; the default set tops out at ten seconds and would put every digest and
      // every retried delivery in one +Inf bucket.
      buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000, 3_600_000],
    })
    .register({
      name: DEADLETTER_TOTAL,
      help: 'Deliveries that exhausted their attempt budget and were retained for an operator',
      kind: 'counter',
    })
    .register({
      name: SUPPRESSED_TOTAL,
      help: 'Notifications not delivered on any channel, by reason',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: INGESTED_TOTAL,
      help: 'Events accepted at /ingest, by outcome',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: NOTIFICATIONS_TOTAL,
      help: 'Notifications created, by category and priority',
      kind: 'counter',
      labels: ['category', 'priority'],
    })
    .register({
      name: DELIVERIES_PENDING,
      help: 'Deliveries awaiting an attempt',
      kind: 'gauge',
    })
    .register({
      name: DELIVERIES_DEAD,
      help: 'Deliveries in a terminal failed state, by state',
      kind: 'gauge',
      labels: ['state'],
    })
    .register({
      name: DIGESTS_OPEN,
      help: 'Digest batches waiting for their window',
      kind: 'gauge',
    })
    .register({
      name: AWAITING_ALLOWANCE,
      // The wording is the deliverable. micro-org#243 took three wrong diagnoses — bad SMTP
      // credentials, a wrong public URL, a rogue agent — because the only evidence an operator
      // had was `SMTP 535` and a counter labelled `upstream_error`. A series whose help text says
      // "the provider's allowance is spent" ends that conversation before it starts.
      //
      // Alert on it above zero for longer than one allowance period. Above zero for minutes is
      // the system working: the delivery is parked and will go out when the allowance resets.
      help: 'Deliveries parked because the mail provider\'s sending allowance is spent — NOT a credentials failure',
      kind: 'gauge',
    })
    .register({
      name: RESERVED_DOMAIN_GUARD,
      // ── THE BRACES. THE BELT IS `reserved.ts`, AND THE BELT WAS ALREADY THERE. ──
      //
      // micro-org#390: the rule refusing mail to a reserved domain had been in the tree since
      // 2.4.0, green in CI, and verified on testnet. The mainnet process was an older image that
      // did not contain it, and NOTHING SAID SO for six days while it emptied the daily allowance
      // and a real visitor's verification mail could not be sent at all.
      //
      // 1 means the RUNNING build refuses; 0 means it would route mail to an address the DNS root
      // guarantees can never resolve. Answered at every scrape by driving the real routing
      // function (`reservedDomainGuardIntact`), so the answer is about this process and not about
      // the repository — which is the entire distinction the ticket turns on. Alert on `== 0`, and
      // alert on the series being ABSENT while the service is up: a build old enough to have lost
      // the rule has lost this metric with it, and absence is then the only evidence there is.
      help: '1 if this running build still refuses to route email to a reserved domain (RFC 6761 §6), 0 if it would send',
      kind: 'gauge',
    })
    .register({
      name: RESERVED_DOMAIN_DELIVERIES,
      // The ground truth beside the self-check above: not "can it happen" but "did it". A delivery
      // row for a reserved recipient means the routing rule did not run for that notification,
      // whatever the guard says about the canary. Correct value is zero, forever.
      help: 'Email deliveries ROUTED to a reserved domain in the last hour — nonzero means the routing rule did not run',
      kind: 'gauge',
    })
}
