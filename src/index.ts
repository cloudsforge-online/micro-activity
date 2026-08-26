/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not
 * arbitrary. Each step below carries the reason it must precede the next.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ONE PROCESS, TWO MODULES — WAVE M2.** micro-notify is absorbed here
 * (micro-deploy `docs/service-merge-plan.md`). What that means concretely, and what it does not:
 *
 *   * **One listener**, one port, one `/livez`, one `/readyz`, one `/metrics`. activity serves all
 *     three; notify's copies are filtered out where they are built, not deleted.
 *   * **Two databases**, read through their existing variables and never merged. Each module owns
 *     its pool, and every notify route names the selector its handle comes from — a route that
 *     took the wrong module's database would insert into the wrong `inbox`, which has the same
 *     three columns, and answer 2xx.
 *   * **TWO NETWORK MODELS, AND BOTH SURVIVE.** activity keeps one DATABASE per network and
 *     refuses a network it holds no handle for; notify keeps one database for both and carries the
 *     network as a COLUMN. `RouteSpec.sql` is what lets those two answers coexist — see
 *     `kernel.ts` and `notify/module.ts`.
 *   * **TWO JOB RUNNERS, TWO CONCURRENCY BUDGETS.** Not one. The merge plan's mechanics step 4
 *     says "jobs and topic subscriptions are unioned", and unioning the RUNNERS is precisely the
 *     shape the plan's own safety condition forbids: notify's SMTP dispatcher drains in a loop,
 *     sends serially and has no socket timeout, so a wedged mail host would hold a shared budget
 *     and `activity.inbox.prune` would never be claimed. See `notify/module.ts`'s
 *     `NOTIFY_JOB_CONCURRENCY` and `starvation.test.ts`.
 *   * **One `Lifecycle`, two hard probes.** `/readyz` reports both databases. A merged readiness
 *     that only probed activity's would answer 200 while every notification was failing.
 *   * **Two job planes, labelled.** `jobs_pending` and `jobs_overdue` carry no `kind`, so the
 *     `module` label is what stops each module's sample erasing the other's every scrape.
 *   * **THIS FILE NEVER HOLDS NOTIFY'S SECRETS.** It does not import `./notify/env.ts`,
 *     `./notify/email.ts` or `./notify/channels.ts`; it calls one factory and receives five
 *     things, none of which names a credential. See `notify/module.ts`'s header for the three
 *     layers, and `moduleboundary.test.ts` for the guard.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy. That
 * is why no `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under
 * rule 9 it must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql, networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createMergedServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { retentionSummary, type Db } from './records.ts'
import { createNotifyModule } from './notify/module.ts'

/** This module's own metric label. See `notify/module.ts`'s `MODULE_LABEL` for the argument. */
const MODULE_LABEL = 'activity'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable. `./notify/module.ts` imports its own
//    `env.ts`, which does the same for the notify half — so a merged pod refuses to boot unless
//    BOTH configurations are complete, rather than serving half a bus tail.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ONE REGISTRY, AND A LABELLED VIEW FOR EACH MODULE'S JOB PLANE.
//
// `metrics` is THE registry. It is what `/metrics` renders, what the three `register*` helpers
// write specs into, and what the kernel writes `http_requests_total` through — deliberately
// unlabelled there, because one listener serves both modules and the `route` label already says
// which. `/metrics` renders THIS object and not a view: rendering a view works, because a view
// shares the registry's series maps by reference, but it reads as though the view owned the
// endpoint, and that is what the next person adding a third module would copy.
//
// `jobMetrics` is activity's view, and it exists for one measured collision. `jobs_pending` and
// `jobs_overdue` carry NO `kind` at all, so each module's `beforeScrape` writes the IDENTICAL
// series: one OVERWRITES the other every scrape and a wedged queue is ABSENT from the graph rather
// than high. Nobody alerts on absent. (The job KINDS do not collide — `activity.*` against
// `notify.*` — which is why this wave's collision is the unlabelled pair and not, as in wave M1,
// `jobs_failed_total{kind="rollup"}` summing two unrelated queues.)
//
// The label is stamped rather than declared because widening every spec's `labels` would push
// `module` onto every call site in the estate, including the single-service ones that have nothing
// to say about it — see `Metrics.withLabels`.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })

logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const poolOptions = {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
}
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `ACTIVITY_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
//
// This is activity's model and NOT notify's. The notify module builds its own selector over its
// one database, because the network is a column there. Neither is imposed on the other.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

// 4. Assert the schema. This does **not** migrate. Failing here rather than serving is the point:
//    a replica of the new code answering requests against the old schema corrupts data quietly,
//    whereas a container that refuses to start is a deploy that visibly stops.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres-activity', (signal) =>
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
  )
  .addProbe(
    // Soft. If identity is down this service still serves everything that does not need a fresh
    // key — and marking it hard means one identity blip removes every service in the estate from
    // its balancer at once, which is a cascade, not a safety measure.
    //
    // It matters more here than in most services: both ingest paths are authenticated by a
    // signature, so a bus tail that stopped consuming because identity blinked would be a feed and
    // a notification pipeline that fall behind for a reason unrelated to anything they do.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )

// 6. The identity verifier. ONE for the process: both modules read the same JWKS, and two clients
//    would mean two caches, two refreshes and two ways to be stale.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })

const db = sql as unknown as Db
// ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
//
// The `networkSql` key below used to be the literal `mainnet`. Same image, same code,
// different env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and
// then refused every request the gateway stamped `CF-Network: testnet`, because it genuinely
// held no handle by that name. Five services crash-looped on it within ten minutes of the
// first deploy: the refusal was right, the registration was wrong.
//
// `CF_NETWORK_SINGLE` is how a single-network pod says which estate it is. The render sets it
// for every deployment; `mainnet` remains the default only for a bare `pnpm dev`.
const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 7. THE NOTIFY MODULE.
//
// Built before the routes, because its routes are mounted with activity's and its probe belongs on
// the Lifecycle the health handlers report. It throws rather than exiting — the exit code is this
// file's to choose, and a module that killed the process would take the activity feed down for a
// notification fault without a line saying so.
//
// **Five things come back and none of them is a secret.** There is no `SmtpConfig` in this scope,
// no `NOTIFY_INGEST_SIGNING_SECRET`, and no notify `env` import above — which is why no activity
// handler can close over notify's ingest key even by mistake, nor notify's over activity's.
// ══════════════════════════════════════════════════════════════════════════════════════════════
let notify: Awaited<ReturnType<typeof createNotifyModule>>
try {
  notify = await createNotifyModule({
    metrics,
    verifier,
    claimingJobs: () => lifecycle.claimingJobs,
    // The host's tracker, so a drain waits for notify's in-flight writes too. One process, one
    // drain: work tracked on a Lifecycle nobody drains has no protection at all.
    track: () => lifecycle.track(),
  })
} catch (err) {
  logger.fatal('the notify module could not start', { err })
  await sql.end({ timeout: 5 }).catch(() => {})
  await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}
lifecycle.addProbe(notify.probe)
logger.info('notify module ready', { schemaVersion: notify.schemaVersion })

// 8. Routes. After the Lifecycle so the health handlers report real state, after the pool so
//    ingest is real rather than a lazily-connected surprise on the first delivery, and after the
//    notify module so both tables are mounted on one listener.
const server = createMergedServer(
  {
    lifecycle,
    logger,
    metrics,
    verifier,
    // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
    sql: networkSql({
      [ownNetwork]: sql as unknown as RuntimeSql,
      ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
    }),
    // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
    // call, because those go container to container and never reach the gateway that stamps one.
    // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
    // request; it only answers the internal callers that never had one.
    singleNetwork: ownNetwork,
    ingest: {
      sql: db,
      logger,
      metrics,
      secrets: env.ingestSecrets,
      toleranceMs: env.deliveryToleranceMs,
    },
    // Queue depth and the unclassified backlog are sampled at scrape time rather than on a timer.
    // There is no `setInterval` in this repository, and CI greps for one — rule 8.
    //
    // BOTH modules' gauges, because there is one `/metrics` and a module whose gauges were never
    // refreshed would publish the values it happened to hold at boot — which reads as a queue that
    // is permanently empty rather than one nobody is sampling.
    beforeScrape: async () => {
      const stats = await queue.stats()
      // The VIEW, not the registry. These two carry no `kind`, so this is the one line where the
      // two modules would otherwise erase each other every scrape.
      jobMetrics.set('jobs_pending', stats.pending)
      jobMetrics.set('jobs_overdue', stats.overdue)
      const quarantined = await sql<{ n: number }[]>`
        select count(*)::int as n from activity_records where category = 'unclassified'
      `
      metrics.set('activity_unclassified_total', quarantined[0]?.n ?? 0)

      // Read from the schema's own view, not from anything this process remembers. If the prune job
      // has been dead for a month this is the number that says so — see the metric's registration.
      for (const row of await retentionSummary(db)) {
        metrics.set('activity_retention_overdue_total', row.overdue, { class: row.retentionClass })
      }

      await notify.beforeScrape()
    },
  },
  notify.routes,
)

// 9. The job runners, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
//
//    TWO runners, and see the block at the top of this file for why unioning them would be the one
//    shape that makes this merge unsafe.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 2,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
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

registerHandlers(runner, {
  sql: db,
  logger,
  metrics: jobMetrics,
  inboxRetentionDays: env.inboxRetentionDays,
  retentionDays: env.retentionDays,
})
await seedRecurring(queue)
runner.start()
notify.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//     balancer is allowed to send traffic — and it answers for BOTH databases, because both probes
//     are on this Lifecycle. Flipping this before `listen()` would advertise a replica that has no
//     socket.
lifecycle.markReady()

// 12. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready. Hooks run in reverse registration order, so the
//     server closes first, then the runners stop claiming and drain, then the pools close with
//     nothing left to use them.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  await sqlTestnet?.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
// Registered after activity's two, so it runs BEFORE them — hooks run in reverse registration order
// and the one below (the server) is therefore first of all. The sequence a SIGTERM produces is:
// stop accepting, drain and close notify, drain and close activity. Both runners have already
// stopped CLAIMING by then, because `claimingJobs` above is the host's and both read it.
lifecycle.onShutdown(async () => {
  await notify.stop()
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
