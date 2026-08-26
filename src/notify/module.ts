/**
 * The notify module: this half of the merged process, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE SEAM, AND IT IS THE ONLY PLACE `NOTIFY_INGEST_SIGNING_SECRET`, THE SMTP
 * CREDENTIALS AND THE GATEWAY TOKEN ARE REACHABLE FROM.**
 *
 * Wave M2 (micro-deploy `docs/service-merge-plan.md`) folds notify into activity's process. Two
 * services sharing a process share a heap, so what used to be a process boundary has to be made
 * out of SCOPE instead — and here that boundary is carrying real weight in both directions:
 *
 *   * `NOTIFY_INGEST_SIGNING_SECRET` authenticates an event that can mint a "your key was
 *     exported" email to any address on file. `ACTIVITY_INGEST_SECRETS` authenticates a write to
 *     the canonical record of what happened to a user's money. Neither should be able to do the
 *     other's job, and before the merge that was guaranteed by them being in different processes.
 *   * `SMTP_PASS` and `NOTIFY_GATEWAY_TOKEN` enter the process in this file's import graph and in
 *     no other. `src/index.ts` — the merged composition root — does not import `./notify/env.ts`,
 *     `./notify/email.ts` or `./notify/channels.ts`, so it never holds an `SmtpConfig` and cannot
 *     pass one anywhere.
 *
 * The three layers, each of which fails closed on its own:
 *
 *   1. **`./env.ts` is imported HERE and nowhere above.** The host's import graph does not reach
 *      it.
 *   2. **`NotifyModule` carries no credential-bearing field.** What this function RETURNS is five
 *      things the host process needs — routes, a readiness probe, a scrape hook and a lifetime —
 *      and none of them names a secret.
 *   3. **Each module's handlers close over their OWN deps.** `handle` takes only `ctx`, so
 *      activity's ingest handler has no `deps` parameter to reach through and vice versa.
 *
 * `src/moduleboundary.test.ts` fails if any of the three is edited away, and it is written so that
 * it cannot pass by finding nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything below is `notify/src/index.ts` as it stood, in the same order and for the same stated
 * reasons. What changed is only what a module in somebody else's process cannot own: the listener,
 * the `Lifecycle`, the `Verifier` and the `Metrics` registry are the HOST's and are passed in; the
 * database pool, the channel adapters, the pipeline, the job queue and the job runner are this
 * module's and are built here.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Lifecycle, Probe, Release } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import { OPERATIONAL_ROUTES } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env, transportSummary } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import {
  registerServiceMetrics,
  AWAITING_ALLOWANCE,
  DELIVERIES_DEAD,
  DELIVERIES_PENDING,
  DIGESTS_OPEN,
  RESERVED_DOMAIN_DELIVERIES,
  RESERVED_DOMAIN_GUARD,
  RESERVED_DOMAIN_WINDOW_MS,
} from './metrics.ts'
import { createRoutes, type PrincipalVerifier } from './server.ts'
import {
  BROADCAST_KIND,
  DISPATCH_KIND,
  NOTIFY_JOB_CONCURRENCY,
  registerHandlers,
  rescheduleRecurring,
  seedRecurring,
} from './jobs.ts'
import { emailAdapter, smtpConfigured } from './email.ts'
import { gatewayAdapter, inAppAdapter, registryOf } from './channels.ts'
import { webhookAdapter } from './webhook.ts'
import { deliveryStats, openDigestCount, postgresNotifyStore, reservedDomainDeliveries } from './store.ts'
import { reservedDomainGuardIntact, type PipelineDeps } from './pipeline.ts'
import type { Db } from './store.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * `jobs_pending` and `jobs_overdue` carry no `kind` at all, so without this each module's sample
 * OVERWRITES the other's and a wedged queue is ABSENT from the graph rather than high. Nobody
 * alerts on absent. The two modules' job KINDS happen not to collide — `activity.*` against
 * `notify.*` — so `jobs_failed_total{kind=…}` was never going to be summed here the way it was in
 * wave M1; the unlabelled pair is the whole of the collision, and it is enough.
 */
export const MODULE_LABEL = 'notify'

/** What the host process supplies. Deliberately nothing this module could hide a secret inside. */
export interface HostRuntime {
  /**
   * The process-wide registry — the object the host's `/metrics` renders, not a view of it.
   *
   * This module registers its `notify_*` specs on it directly (those names collide with nothing)
   * and writes its JOB metrics through `metrics.withLabels({ module })`, which is the family that
   * does collide — see `MODULE_LABEL`. A view shares the registry's spec and series maps by
   * reference, so one endpoint carries both modules either way.
   */
  readonly metrics: Metrics
  /** The host's identity verifier. One JWKS client for the process; both modules read it. */
  readonly verifier: PrincipalVerifier
  /**
   * The host `Lifecycle`'s `claimingJobs`, as a function.
   *
   * A function and not the `Lifecycle` itself, deliberately. This module has no business marking
   * the process ready or draining it — those are the host's, and one of the two ways a merged
   * process goes wrong is a module deciding a lifetime it does not own. What it DOES need is the
   * one bit: a replica that has begun draining must stop claiming jobs before it stops serving, in
   * BOTH modules, or the drain window is spent running work the pod is about to abandon.
   */
  claimingJobs(): boolean
  /**
   * The host `Lifecycle`'s `track`, as a function.
   *
   * Four of this module's routes wrap their database work in `lifecycle.track()` so a drain waits
   * for an in-flight preference write or ingest rather than abandoning it. That has to be the
   * HOST's tracker: this process has one drain, and work tracked on a Lifecycle nobody drains is
   * work with no protection at all. Handed as a function for the same reason `claimingJobs` is —
   * so the module cannot reach `markReady`, `readyz` or the shutdown hooks.
   */
  track(): Release
}

/**
 * What the host process gets back. **No field here names a secret, and that is the point** — see
 * the file header, layer 2.
 */
export interface NotifyModule {
  /**
   * The routes to mount beside activity's, each already closed over this module's deps AND stamped
   * with this module's database selector. The three operational paths are NOT among them; see
   * `mountableRoutes` below.
   */
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probe for THIS module's database, for the host's one `Lifecycle`.
   *
   * Hard, and that is the whole reason it is returned rather than kept: a merged `/readyz` that
   * probed only activity's database would answer 200 while every notification in the estate was
   * failing, and the balancer would keep sending traffic to it. A merged readiness that does not
   * reflect both halves is a regression on two working services.
   */
  readonly probe: Probe
  /** Sample this module's gauges. Called from the host's `/metrics`, never on a timer — rule 8. */
  beforeScrape(): Promise<void>
  /** Start claiming jobs. Called after the schema is asserted and before the socket accepts. */
  start(): void
  /** Stop claiming, drain, and close the pool. Registered on the host's shutdown hooks. */
  stop(): Promise<void>
  /** For the host's boot line. The version `assertSchemaAtLeast` was satisfied at. */
  readonly schemaVersion: number
}

/**
 * Build the notify half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take the activity feed down for a notification fault at a point where
 * the host has a logger and a `fatal` line to write. Every failure below was an `exit(1)` in the
 * standalone service and still stops the boot — it just stops it one frame further out.
 */
export async function createNotifyModule(host: HostRuntime): Promise<NotifyModule> {
  // 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
  //    exited with a structured line naming the variable and never its value.

  // 2. Telemetry.
  //
  //    `metrics` is the HOST's registry — the object `/metrics` renders. Specs registered on it are
  //    on that page, and this module's domain names are all `notify_`-prefixed, so nothing there
  //    collides with anything.
  //
  //    `jobMetrics` is this module's labelled VIEW, and it exists for the one family that DOES
  //    collide. See `MODULE_LABEL`. A view writes into the same series maps, so both modules are
  //    still on one page.
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({
    service: SERVICE,
    level: env.logLevel,
    version: env.version,
    env: env.env,
    // Never passed to a logger, but a redaction key costs nothing and closes the accident where
    // somebody logs the whole config object while debugging.
    redactKeys: ['pass', 'smtp', 'ingestSigningSecrets', 'gateways', 'token'],
  })
  registerServiceMetrics(metrics)
  logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

  // Which channels this deployment can actually reach, at info, on every boot. Nimbus already does
  // this for mail and it is the single most useful line in its output: "did this deployment send
  // that, or did it record it and stay silent" is otherwise answered by reading configuration on a
  // host you may not have. Channel names only — never a credential.
  logger.info('transports', transportSummary(env))

  // 3. The database pool. Opened before the schema assertion for the obvious reason that the
  //    assertion is a query, and before the probe because the probe closes over it.
  const sql = postgres(env.databaseUrl, {
    max: env.databasePoolMax,
    // postgres.js writes notices to stderr as unstructured text by default, which is how a
    // connection string ends up in a log the collector cannot parse.
    onnotice: () => {},
  })

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
  }

  // 4. Assert the schema. This does **not** migrate. Failing here rather than serving is the point:
  //    a replica of the new code answering requests against the old schema corrupts data quietly.
  try {
    await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
  } catch (err) {
    await close()
    throw err
  }

  // ── THIS MODULE'S SELECTOR, AND WHY BOTH NETWORKS RESOLVE TO ONE HANDLE ─────────────────────
  //
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // **THE TWO MODULES DISAGREE ABOUT WHAT A NETWORK IS, AND THIS LINE IS WHERE THAT IS SETTLED.**
  //
  // activity keeps one DATABASE per network and refuses a network it holds no handle for. notify
  // is a class B′ singleton (micro-deploy `docs/network-consolidation.md` §5): ONE pipeline, ONE
  // SMTP allowance, ONE dead-letter view, and the network is a COLUMN — `deliveries.network`,
  // added by the `delivery-network` migration. There is no `NOTIFY_DATABASE_URL_TESTNET` and there
  // must not be: two pipelines would mean two allowances against one 150/day account and two
  // places to look when somebody says they got nothing.
  //
  // So this selector answers BOTH networks with the SAME handle, and it says so out loud rather
  // than registering one and letting `for('testnet')` throw. That refusal is exactly right for
  // activity and would be a REGRESSION here: notify serves testnet requests today, out of this
  // database, with the estate stamped on the row.
  //
  // What it buys is the thing `RouteSpec.sql` exists for: every route below carries this selector,
  // so `ctx.sql` inside a notify handler is NOTIFY's pool whichever estate the request came from,
  // and can never be activity's. Both databases own a table called `inbox` with identical columns,
  // so the mistake this prevents is not a type error at the wire — it is an insert into the other
  // module's dedupe table that succeeds and makes the next genuine delivery a "duplicate".
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const notifySql = networkSql({
    mainnet: sql as unknown as RuntimeSql,
    testnet: sql as unknown as RuntimeSql,
  })

  // 5. The channel adapters. Every one is constructed whether or not it is configured: an
  //    unconfigured adapter answers `no_transport`, which is a recorded, countable delivery outcome
  //    and an explicitly supported way to run. Omitting the adapter instead would produce
  //    "no adapter registered", which says the same thing in a way an operator cannot act on.
  const adapters = registryOf([
    inAppAdapter(),
    emailAdapter({ smtp: env.smtp }),
    gatewayAdapter({ channel: 'web_push', url: env.gateways.webPushUrl, token: env.gateways.token }),
    gatewayAdapter({ channel: 'mobile_push', url: env.gateways.mobilePushUrl, token: env.gateways.token }),
    gatewayAdapter({ channel: 'sms', url: env.gateways.smsUrl, token: env.gateways.token }),
    webhookAdapter(),
  ])

  const pipeline: PipelineDeps = {
    sql,
    logger,
    metrics,
    adapters,
    publicUrl: env.publicUrl,
    maxAttempts: env.deliveryMaxAttempts,
    instanceId: env.instanceId,
    // The same predicate the adapter uses to decide whether it can send at all, read once here so
    // the pipeline and the adapter cannot disagree about whether this deployment has a mailer. It
    // decides whether a notification that reaches nobody by email is counted: on a deployment with
    // no SMTP that is a configuration choice, and on this one it is the defect the owner reported.
    emailConfigured: smtpConfigured(env.smtp),
  }

  // 6. The queue and the runner's dependencies.
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })

  /**
   * Pull the dispatcher forward.
   *
   * `earliest` moves the existing recurring row's `run_at` back rather than creating a second
   * dispatcher, so calling it on every ingest is safe. Without it a critical notification waits for
   * the next poll — up to a second, which is fine, but the digest flush needs the same nudge and
   * "the batch fires on its schedule" is a promise this service makes.
   */
  const enqueueDispatch = async (): Promise<void> => {
    await queue.enqueue({ kind: DISPATCH_KIND, key: 'queue', onConflict: 'earliest' })
  }

  // 7. The routes, over THIS module's deps. Every handler `createRoutes` returns has closed over
  //    the store, the pipeline and the ingest secrets; none of them is reachable from the host.
  const routes = mountableRoutes(
    createRoutes({
      // The host's `track`, wrapped in a Lifecycle shape whose other two methods throw — see
      // `hostLifecycle`. `/livez` and `/readyz` are the host's in this process.
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: notifySql,
      store: postgresNotifyStore(sql),
      pipeline,
      ingestSecrets: env.ingestSigningSecrets,
      enqueueBroadcast: async (broadcastId) => {
        await queue.enqueue({
          kind: BROADCAST_KIND,
          // The lease key names one broadcast: two broadcasts must fan out concurrently, and one
          // must not fan out twice.
          key: `broadcast:${broadcastId}`,
          payload: { broadcastId },
          onConflict: 'keep',
        })
      },
      enqueueDispatch,
      // Unused: `/metrics` is the host's and calls `beforeScrape()` below directly. Left off rather
      // than wired to nothing, so nobody reads this as a second scrape path.
    }),
    notifySql,
  )

  // 8. The job runner. Started by `start()`, after the host has finished booting.
  const reschedule = rescheduleRecurring(queue, logger)
  const runner = new JobRunner({
    queue,
    concurrency: NOTIFY_JOB_CONCURRENCY,
    pollMs: 1_000,
    // Both halves of the answer. `started` is this module's own gate — nothing may be claimed
    // before the host has finished booting — and `host.claimingJobs()` is the drain, which is the
    // host's to decide and must apply to both modules at once.
    shouldClaim: () => started && host.claimingJobs(),
    onEvent: (event) => {
      // EVERY line here goes through the labelled view, including the ones carrying a `kind` that
      // does not collide today. A counter whose module is knowable only by reading the kind string
      // is a counter that stops being attributable the moment somebody adds a third module.
      if (event.kind) {
        if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', { kind: event.kind })
        if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', { kind: event.kind })
        if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', { kind: event.kind })
        if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', { kind: event.kind })
        if (event.durationMs !== undefined) {
          jobMetrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
        }
      }
      if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
        logger.error('job failure', { ...event })
      }
      reschedule(event)
    },
  })
  let started = false
  registerHandlers(runner, { pipeline, batchSize: env.dispatchBatchSize, enqueueDispatch })

  return {
    routes,
    probe: postgresProbe('postgres-notify', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores
      // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
      // database is not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
    beforeScrape: async () => {
      // The view, not the registry. `jobs_pending` and `jobs_overdue` carry no `kind`, so this one
      // line is where the two modules would otherwise erase each other every scrape.
      const jobs = await queue.stats()
      jobMetrics.set('jobs_pending', jobs.pending)
      jobMetrics.set('jobs_overdue', jobs.overdue)

      const deliveries = await deliveryStats(sql)
      metrics.set(DELIVERIES_PENDING, deliveries.pending)
      metrics.set(DELIVERIES_DEAD, deliveries.dead, { state: 'dead' })
      metrics.set(DELIVERIES_DEAD, deliveries.undeliverable, { state: 'undeliverable' })
      metrics.set(AWAITING_ALLOWANCE, deliveries.awaitingAllowance)
      metrics.set(DIGESTS_OPEN, await openDigestCount(sql))
      // micro-org#390. Answered HERE, at scrape time, and not once at boot: a boot-time answer
      // describes the build that booted, and a rolling replacement puts a different build behind the
      // same service name without ever booting this line again. The question is "does the process
      // being scraped right now still refuse", so it is asked of the process being scraped right now.
      metrics.set(RESERVED_DOMAIN_GUARD, reservedDomainGuardIntact() ? 1 : 0)
      metrics.set(RESERVED_DOMAIN_DELIVERIES, await reservedDomainDeliveries(sql, RESERVED_DOMAIN_WINDOW_MS))
    },
    start: () => {
      started = true
      void seedRecurring(queue)
        .then(() => runner.start())
        .catch((err: unknown) => logger.error('failed to seed recurring jobs', { err }))
    },
    stop: async () => {
      started = false
      const clean = await runner.stop(20_000)
      logger.info('job runner stopped', { clean })
      await close()
      logger.info('database pool closed')
    },
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * The databases this module owns, for the merged migrator.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MIGRATOR MUST NOT IMPORT `./env.ts` EITHER, AND THIS IS WHY IT DOES NOT HAVE TO.**
 *
 * `src/migrator.ts` needs two facts about this module — where its database is and what to apply to
 * it — and the obvious way to get them is to import this module's `env`. That is the whole
 * configuration record, `SMTP_PASS` and `NOTIFY_INGEST_SIGNING_SECRET` included: a second entry
 * point holding both, in a process nobody thinks of as serving anything.
 *
 * It is a real hole rather than a stylistic one. The migrator runs as an init container with the
 * same environment as the service, so the values are genuinely present in it; what decides whether
 * a stack trace, a log line or a crash dump from that process can carry them is whether any binding
 * there can reach them. This function returns four scalars and an array of DDL, so none can.
 *
 * **ONE ENTRY, AND THAT IS NOT AN OVERSIGHT.** notify has no `NOTIFY_DATABASE_URL_TESTNET` — see
 * the selector in `createNotifyModule` for why the network is a column here rather than a database.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function notifyMigrationTargets(): readonly Target[] {
  return [
    {
      module: SERVICE,
      network: 'primary',
      url: env.databaseUrl,
      migrations: MIGRATIONS,
      baselineVersion: BASELINE_VERSION,
    },
  ]
}

/**
 * Drop the three operational paths from this module's table, and stamp its selector on the rest.
 *
 * ── WHY THE DROP, AND WHY IT IS A FILTER RATHER THAN A DELETION ────────────────────────────────
 *
 * One process serves ONE `/livez`, ONE `/readyz` and ONE `/metrics`; mounting two of each would
 * make the second unreachable — first-wins matching — which is a shadowed handler nobody would
 * ever notice was dead. activity's win, because activity is the module the estate's monitoring
 * already points at: it holds the only public router of the pair, and it is the one a beacon
 * synthetic monitor probes.
 *
 * Nothing is lost by it. `/metrics` renders the host's registry, which this module's views write
 * into, so every `notify_*` series is on the merged page; `beforeScrape` above is what keeps its
 * gauges fresh, and `probe` is what keeps `/readyz` honest about this module's database.
 *
 * It is a filter and NOT a deletion from `server.ts` because that table is also the one
 * `createServer` mounts, which is the surface `server.test.ts` drives on its own — and because the
 * standalone micro-notify service is still deployed until cutover.
 */
function mountableRoutes(
  specs: readonly RouteSpec<Db>[],
  sql: ReturnType<typeof networkSql>,
): readonly RouteSpec<Db>[] {
  return specs
    .filter((spec) => !OPERATIONAL_ROUTES.has(spec.path))
    .map((spec) => ({ method: spec.method, path: spec.path, sql, handle: spec.handle }))
}

/**
 * The `Lifecycle` shape `createRoutes` demands, with exactly one method wired to a real one.
 *
 * `track()` is the host's, because four of this module's routes wrap real database work in it and
 * the process has ONE drain. `livez()` and `readyz()` throw, because the two routes that call them
 * are filtered out above — passing the host's real answers would suggest those handlers are live
 * when they are not, which is the kind of "wired to something plausible" that makes dead code look
 * alive. If the filter is ever removed the shadowed route fails loudly on its first request
 * instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): Lifecycle {
  return {
    track: () => host.track(),
    livez: () => {
      throw new Error('notify does not serve /livez in the merged process — activity does')
    },
    readyz: () => {
      throw new Error('notify does not serve /readyz in the merged process — activity does')
    },
  } as unknown as Lifecycle
}
