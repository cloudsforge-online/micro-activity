/**
 * The HTTP kernel: matching, the request lifecycle, and the shapes a route answers in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NO ROUTE LIVES HERE, AND NOTHING HERE KNOWS WHAT THIS SERVICE IS.** This file imports the
 * runtime packages and `node:http` and nothing else from `src/` — no store, no decoder, no domain
 * error. That is the whole point of it: `mountRoutes` can be handed one service's routes or two
 * services' routes concatenated, and it cannot tell the difference.
 *
 * The seam exists so that the notification module can be mounted in this process without
 * re-implementing the request lifecycle — the network attribution, the per-request handle, the
 * in-flight gauge and the duration histogram — which is exactly the code that is dangerous to
 * write twice (micro-deploy `docs/service-merge-plan.md`, wave M2). It is lantern's kernel with
 * one thing removed (the browser-facing CORS decoration, which this process has no sink for) and
 * nothing added.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WAVE M2: TWO NETWORK MODELS IN ONE PROCESS, AND WHY THAT IS THIS FILE'S PROBLEM ────────────
 *
 * The two modules do not agree about what a network IS, and both are right about themselves:
 *
 *   * **activity** keeps ONE DATABASE PER NETWORK. It reads `ACTIVITY_DATABASE_URL` and
 *     `ACTIVITY_DATABASE_URL_TESTNET`, opens two pools, and refuses a request for a network it
 *     holds no handle for — because answering a testnet read out of mainnet rows is a query that
 *     SUCCEEDS and says nothing.
 *   * **notify** keeps ONE DATABASE FOR BOTH, and carries the network as a COLUMN
 *     (`deliveries.network`, migration `delivery-network`). It is a class B′ singleton: one
 *     pipeline, one SMTP allowance, one dead-letter view. Two pipelines would mean two allowances
 *     against one 150/day account and two places to look when somebody says they got nothing.
 *
 * A merged process cannot have one answer to "which handle does this request use". So it does not
 * have one: **a route may name the SELECTOR its `ctx.sql` is resolved from** (`RouteSpec.sql`).
 * The kernel resolves it once, at the edge, in the same place and at the same moment it resolves
 * the network. activity's routes take the kernel's own per-network selector; the notify module
 * stamps its own on every route it exports, and that selector answers BOTH networks with the SAME
 * handle — deliberately, because that is what "the network is a column" means.
 *
 * Without this, every notify route would be handed ACTIVITY's database: `select … from inbox`
 * would then read activity's `inbox` — which has the same three columns — succeed, and report
 * nothing at all. That is the failure this file exists to make impossible rather than unlikely.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql, Sql } from '@cloudsforge/db'
import { newRequestId, type Logger, type Metrics } from '@cloudsforge/telemetry'

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

export interface RequestContext<TSql = Sql> {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
  /**
   * The network THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * Not a property of the process: one pod serves both estates since the network consolidation
   * (micro-deploy `docs/network-consolidation.md`), so "which network am I" has no answer.
   */
  readonly network: Network
  /**
   * The database handle for `network`, resolved ONCE, at the edge of the request.
   *
   * Every route uses this rather than reaching for the process-wide handle, because a wrong handle
   * is not an error — it is a query that SUCCEEDS against the other estate's rows and says nothing.
   * `deps.sql` is a `NetworkSql` with no query methods, so the mistake does not compile.
   *
   * Resolved from the selector the route named (`RouteSpec.sql`), or the kernel's own when it named
   * none. In this process that means activity's routes get activity's per-network handle and the
   * notify module's routes get notify's single handle, with the same "a wrong handle is silent"
   * argument now applying ACROSS MODULES as well as across networks.
   */
  readonly sql: TSql
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them makes every health probe a 500 and the pod never
 * becomes ready. Three literal paths rather than a prefix, because this is an exemption from a data
 * boundary; none of them queries the database.
 *
 * Exported because the notify module filters its own copies of these three out before mounting —
 * one process serves exactly one of each, and a shadowed health endpoint looks exactly like a live
 * one. See `notify/module.ts`.
 */
export const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

/**
 * One route, as the module that owns it declares it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`handle` TAKES ONLY `ctx`.** It used to take `(ctx, deps)`, which made every route a function
 * of the ONE dependency bag the process happened to have. Two modules in one process do not share
 * one bag — they have different databases and, critically here, DIFFERENT INGEST SECRETS — so a
 * `deps` parameter threaded by the kernel would have to become a union, and `ACTIVITY_INGEST_SECRETS`
 * would be in scope for the handler that mints a person's security email. Closing over deps at
 * construction time makes that a scope rather than a convention.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface RouteSpec<TSql = Sql> {
  readonly method: string
  /** `/feed/:id`. Used verbatim as the metric label, so cardinality is bounded. */
  readonly path: string
  readonly handle: (ctx: RequestContext<TSql>) => Promise<Reply>
  /**
   * The per-network SELECTOR this route's `ctx.sql` is resolved from.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **OMITTED MEANS "THE KERNEL'S OWN", WHICH IS EVERY ROUTE IN A ONE-MODULE PROCESS.** It is set
   * by a module whose routes are mounted BESIDE another module's, and it is the difference between
   * a merge that works and a merge that is a silent data fault.
   *
   * `mountRoutes` resolves one handle per request, from one selector. Merge two services into one
   * process without this and the second module's handlers are handed the FIRST module's database.
   * activity and notify both own a table called `inbox` and both own a table called `jobs`, and
   * the two `inbox` tables have IDENTICAL COLUMNS — so the wrong handle here is not even a type
   * error at the wire: it is an insert that lands in the other module's dedupe table, succeeds,
   * and makes the next genuine delivery of that event a "duplicate".
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly sql?: NetworkSql
}

/** A `RouteSpec` with its path compiled. Built by `mountRoutes`, never by a route module. */
interface Route<TSql = Sql> {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext<TSql>) => Promise<Reply>
  readonly sql?: NetworkSql
}

/**
 * Compile `/feed/:id` into a matcher. The segment pattern excludes `/` so a parameter cannot
 * swallow the rest of the path and make one route answer for another.
 */
export function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

/**
 * What the request lifecycle itself needs — and deliberately nothing a route needs.
 *
 * A service's own `ServerDeps` extends this, so `mountRoutes(createRoutes(deps), deps)` typechecks
 * while the kernel still cannot see the token, the verifier or the ingest secrets.
 */
export interface MountDeps {
  readonly logger: Logger
  readonly metrics: Metrics
  /**
   * The per-network SELECTOR, not a handle. `NetworkSql` has no query methods, so a route that
   * reaches for the process-wide handle instead of `ctx.sql` does not compile — which is the point:
   * a wrong handle is not an error, it is a query that SUCCEEDS against the other estate's rows.
   */
  readonly sql: NetworkSql
  /**
   * The network to assume when no `CF-Network` arrives, or `undefined` to refuse. `CF_NETWORK_SINGLE`,
   * for `pnpm dev`, which has no gateway in front of it. Never set in production.
   */
  readonly singleNetwork?: Network
}

/**
 * Mount a set of route specs on a `node:http` server.
 *
 * Everything between the socket and `handle(ctx)` is here: the request id, the URL, matching, the
 * network attribution, the per-request database handle, the in-flight gauge and the two HTTP
 * metrics. A route module supplies specs and never sees any of it.
 */
export function mountRoutes<TSql>(specs: readonly RouteSpec<TSql>[], deps: MountDeps): Server {
  const routes: Route<TSql>[] = specs.map((spec) => ({
    method: spec.method,
    path: spec.path,
    pattern: compile(spec.path),
    handle: spec.handle,
    ...(spec.sql ? { sql: spec.sql } : {}),
  }))
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route<TSql> | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // ── THE NETWORK, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ──────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a cross-network write nothing would ever flag.
    //
    // The operational endpoints are exempt because kubelet and Prometheus do not come through the
    // gateway and never send the header. Refusing them makes the pod never become ready.
    //
    // WHICH DATABASE, alongside WHICH NETWORK. A route mounted by another module names its own
    // selector; everything else takes the kernel's. Read here, before either resolution, so the
    // two answers come from one place and cannot disagree.
    const selector = matched?.sql ?? deps.sql

    const networkless = matched !== undefined && OPERATIONAL_ROUTES.has(matched.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? selector.networks[0] ?? 'mainnet')
        : requestNetwork(req.headers, deps.singleNetwork ? { fallback: deps.singleNetwork } : {})
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(
        res,
        errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId),
        requestId,
      )
      finish(500, 'unknown')
      return
    }

    // ── RESOLVED INSIDE A TRY, AND THAT IS NOT DEFENSIVE PADDING ───────────────────────────────
    //
    // `selector.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw would escape the `void`
    // expression past a `.catch` that is not attached yet, and the listener would return having
    // sent NOTHING — the connection then hangs until the client gives up.
    let sql: TSql
    try {
      // The one cast in this file. `Sql` and `postgres`'s handle are two published views of the
      // same object, so `TSql` names which view the mounted module reads through, never a
      // different value.
      sql = selector.for(network) as unknown as TSql
    } catch (err) {
      log.error('no usable database handle for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }

    void answer(matched, { req, url, requestId, log, params, network, sql })
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
      })
  })
}

/**
 * Run the chosen handler, or answer the bare 404 when nothing matched.
 *
 * `async` rather than a bare call so a handler that throws SYNCHRONOUSLY becomes a rejected promise
 * the `.catch` above is already attached to, rather than a throw escaping the `void` expression.
 */
async function answer<TSql>(
  route: { readonly handle: (ctx: RequestContext<TSql>) => Promise<Reply> } | undefined,
  ctx: RequestContext<TSql>,
): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  return await route.handle(ctx)
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
export function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

export function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // A feed page is a point-in-time answer and a cached one is a feed that stops updating.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
