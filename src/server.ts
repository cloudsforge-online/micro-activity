/**
 * The listener, and this service's domain metrics.
 *
 * The route table moved to `./routes.ts` and the request lifecycle to `./kernel.ts`; what is left
 * here is the two functions a composition root calls and the metric declarations, which belong
 * beside neither.
 *
 * Plain `node:http`, following the service template. The parts that matter — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent.
 */

import type { Server } from 'node:http'
import { Metrics } from '@cloudsforge/telemetry'
import { STORED_CATEGORIES, type StoredCategory } from './categories.ts'
import { mountRoutes, type RouteSpec } from './kernel.ts'
import { createRoutes, type ServerDeps } from './routes.ts'
import type { Db } from './records.ts'

export { ACTIVITY_INGEST_PATH, INGEST_PATHS } from './routes.ts'
export type { PrincipalVerifier, ServerDeps } from './routes.ts'

/**
 * Domain metrics, declared rather than inferred from a log line — AD-20.
 *
 * `activity_ingest_lag_seconds` is the one an operator watches. It is measured from `occurredAt`,
 * so it answers "how far behind the facts is the feed" — which is the question a user is really
 * asking when they say their deposit has not appeared, and it is a question no log line can be
 * grepped into answering.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'activity_records_total',
      help: 'Activity records written, by category',
      kind: 'counter',
      labels: ['category'],
    })
    .register({
      name: 'activity_ingest_lag_seconds',
      help: 'Seconds between an event occurring and its record being written',
      kind: 'histogram',
      labels: ['producer'],
      // Seconds, not the millisecond default. A feed that is a minute behind is fine and one that
      // is an hour behind is an incident, so the buckets have to span both.
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3_600],
    })
    .register({
      name: 'activity_duplicates_dropped_total',
      help: 'Redelivered events that already had a record. Expected; a climbing rate is not.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'activity_unclassified_total',
      help: 'Records quarantined because this build has no classifier for their topic',
      kind: 'gauge',
      labels: [],
    })
    .register({
      // The signal that used not to exist. A producer that starts sending a field this service
      // never declared is invisible in every other metric here; this is the one that moves.
      name: 'activity_payload_keys_dropped_total',
      help: 'Payload keys refused by the per-topic allowlist, by topic',
      kind: 'counter',
      labels: ['topic'],
    })
    .register({
      name: 'activity_records_pruned_total',
      help: 'Records deleted for reaching their retention period, by retention class',
      kind: 'counter',
      labels: ['class'],
    })
    .register({
      /**
       * Records past their retention period and still here.
       *
       * **This is the alarm for the prune job being dead**, and it is deliberately scraped from the
       * `activity_records_retention` view rather than derived from the job's own output. A job that
       * reports how much it deleted says nothing when it stops running; a gauge computed from the
       * table says the same true thing whether the job ran an hour ago or never. Healthy is a flat
       * zero — anything else is a retention period the service is currently not honouring.
       */
      name: 'activity_retention_overdue_total',
      help: 'Records past their retention period that have not been deleted, by retention class',
      kind: 'gauge',
      labels: ['class'],
    })
}

/**
 * The listener, activity's routes only.
 *
 * One line, and it says the whole design: build this module's routes against this module's
 * dependencies, then hand them to a kernel that cannot see either. Kept as its own export because
 * every one of `server.test.ts`'s cases drives exactly this surface, and because a merged listener
 * that could not also be built without the second module would make activity untestable alone.
 */
export function createServer(deps: ServerDeps): Server {
  return mountRoutes(createRoutes(deps), deps)
}

/**
 * The listener this process actually runs: activity's routes, then the notify module's.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO DEPENDENCY BAGS, NEVER ONE.** `deps` is activity's and nothing else; `mounted` arrived as
 * closures that had already captured a bag this function has no name for. That asymmetry is the
 * merge's central safety property — this signature CANNOT be handed notify's ingest secret,
 * because there is no parameter it would arrive through, and it cannot hand notify's routes
 * activity's, for the same reason in the other direction.
 *
 * Order is first-wins, and activity goes first for one reason that matters: `/livez`, `/readyz`
 * and `/metrics` are activity's in this process (see `notify/module.ts`'s `mountableRoutes` for
 * why), and a mounted module must not be able to shadow them by accident. A shadowed health
 * endpoint looks exactly like a live one.
 *
 * Checked rather than assumed: apart from those three the path sets are disjoint, and the ingest
 * collision that made them not disjoint is resolved by giving each module a path of its own —
 * `/ingest/activity` and `/ingest/notify`, with the bare `/ingest` answering 410 naming both.
 * `merged.test.ts` pins all of it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function createMergedServer(deps: ServerDeps, mounted: readonly RouteSpec<Db>[]): Server {
  return mountRoutes([...createRoutes(deps), ...mounted], deps)
}

/** Exported for the test that asserts the column constraint and this list agree. */
export const FEED_CATEGORIES: readonly StoredCategory[] = STORED_CATEGORIES
