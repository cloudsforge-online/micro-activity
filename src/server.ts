/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template. The parts that matter — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent.
 *
 * ---------------------------------------------------------------------------------------------
 * **There is no route here that creates a record from a product's request.**
 *
 * AD-11: activity is written only from the event bus. `POST /ingest` takes a signed event
 * envelope, not a feed entry, and the difference is the whole design — a direct write is a write
 * that can happen without the domain change having committed, which is a feed entry describing a
 * transaction that rolled back. If it is not worth an outbox row, it is not worth a feed entry.
 * ---------------------------------------------------------------------------------------------
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { SIGNATURE_HEADER } from '@cloudsforge/contracts-events'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  statusFor,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { CATEGORIES, STORED_CATEGORIES, isStoredCategory, type StoredCategory } from './categories.ts'
import {
  DeliverySignatureError,
  MalformedEventError,
  ingest,
  parseDelivery,
  verifySignature,
  type IngestDeps,
} from './ingest.ts'
import {
  BadCursorError,
  getRecord,
  listAllRecords,
  listFeed,
  type ActivityRecord,
  type Db,
} from './records.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  readonly ingest: IngestDeps
  readonly beforeScrape?: () => Promise<void>
}

const MAX_BODY_BYTES = 256 * 1024
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/* ------------------------------------------------------------------ plumbing */

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  /** `/feed/:id`. Used verbatim as the metric label, so cardinality is bounded. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/feed/:id` into a matcher. The segment pattern excludes `/` so a parameter cannot
 * swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
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

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
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

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    // `statusFor` is the whole point: it is the one place that decides what an auth failure means,
    // so five services cannot disagree about it again.
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      // Answering 401 here would sign every user in the estate out because identity is having a
      // bad minute. Five services in the estate currently disagree about this.
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof DeliverySignatureError) {
      // 401, and the reason is logged rather than returned. Telling a caller whether their
      // signature was stale or simply wrong tells a forger which half to fix.
      ctx.log.warn('ingest refused: signature', { reason: err.reason })
      return errorReply(401, 'bad_signature', 'the delivery signature was refused', ctx.requestId)
    }
    if (err instanceof MalformedEventError) {
      // 400 with the errors, deliberately: this caller is another service in the estate, and the
      // whole point of contracts-events reporting every problem at once is that its producer
      // needs one round trip to fix them.
      ctx.log.warn('ingest refused: malformed envelope', { errors: err.errors })
      return errorReply(400, 'malformed_event', err.errors.join('; '), ctx.requestId)
    }
    if (err instanceof BadRequestError || err instanceof BadCursorError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

/* ------------------------------------------------------------------ routes */

function buildRoutes(): Route[] {
  const routes: Array<Omit<Route, 'pattern'>> = [
    {
      method: 'GET',
      path: '/livez',
      /**
       * Static, deliberately. Liveness answers one question — should this process be killed and
       * restarted — and a liveness probe that consults a dependency restarts a healthy process
       * every time the database blinks. Readiness is where dependencies belong.
       */
      handle: async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() }),
    },
    {
      method: 'GET',
      path: '/readyz',
      handle: async (_ctx, deps) => {
        const report = await deps.lifecycle.readyz()
        return { status: report.ready ? 200 : 503, body: report }
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handle: async (ctx, deps) => {
        try {
          await deps.beforeScrape?.()
        } catch (err) {
          // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
          // lose every other metric too, and blind the dashboard at the moment it is needed.
          ctx.log.warn('gauge refresh failed; serving the previous values', { err })
        }
        return {
          status: 200,
          text: deps.metrics.render(),
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
        }
      },
    },

    {
      method: 'GET',
      path: '/feed',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        const limit = parseLimit(ctx.url.searchParams.get('limit'))
        const category = parseCategory(ctx.url.searchParams.get('category'), isAdmin(principal))
        const product = parseProduct(ctx.url.searchParams.get('product'))
        const cursor = ctx.url.searchParams.get('cursor') ?? undefined
        const requested = ctx.url.searchParams.get('userId')

        // An operator with no `userId` gets the estate-wide feed, through a different query. A
        // flag that widened a user-scoped query into an estate-wide one is one missing check away
        // from being the worst data leak here.
        if (isAdmin(principal) && requested === null) {
          const page = await listAllRecords(deps.sql, { limit, ...(category ? { category } : {}), ...(product ? { product } : {}), ...(cursor ? { cursor } : {}) })
          return { status: 200, body: toPage(page) }
        }

        const userId = feedOwner(principal, requested)
        const page = await listFeed(deps.sql, {
          userId,
          limit,
          // Only an operator sees internal records: a reconciliation run and anything nobody has
          // classified are not things to put in a user's history.
          includeInternal: isAdmin(principal),
          ...(category ? { category } : {}),
          ...(product ? { product } : {}),
          ...(cursor ? { cursor } : {}),
        })
        return { status: 200, body: toPage(page) }
      },
    },
    {
      method: 'GET',
      path: '/feed/:id',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        const id = ctx.params['id'] ?? ''
        if (!UUID_PATTERN.test(id)) throw new BadRequestError('id must be a uuid')
        const record = await getRecord(deps.sql, id)
        if (!record) throw new NotFoundError(`no activity record ${id}`)
        requireReadAccess(principal, record)
        return { status: 200, body: { record: toWire(record) } }
      },
    },

    {
      method: 'POST',
      path: '/ingest',
      /**
       * The only way a record is created.
       *
       * The order below is the security property: read the raw bytes, prove the caller is a
       * service, verify the signature over exactly those bytes, and only then parse. Parsing
       * first would put a parser in front of the authentication, reachable by anyone who can open
       * a socket.
       */
      handle: async (ctx, deps) => {
        // THE SIGNATURE IS THE AUTHENTICATION, and it is the only gate a producer can pass.
        //
        // This handler used to call `authenticate()` first and demand a service principal — and
        // no producer in the estate could satisfy it: every outbox relay (identity's
        // `outbox.ts` deliver(), and the same shape in every sibling) sends the HMAC signature
        // and the event id, and NO Authorization header. A relay is a background job; it holds
        // no bearer and has no way to mint one. So the route the event bus exists to call
        // answered 401 to the event bus, always — found on the first day a second service was
        // composed next to this one, which is exactly the class of defect §3.3g says only
        // deployment catches.
        //
        // The bearer added nothing the MAC does not: both are shared-secret proofs, and the MAC
        // is over the exact bytes received, which a bearer is not. AD-11's intent — a signed-in
        // person can never write to the canonical feed — holds STRONGER now: a user token is not
        // "forbidden", it is simply not a signature, and there is no code path from any token to
        // a record. `trade` and `worlds` shaped their inboxes this way from the start; this
        // brings the consumer side in line with the producers that already exist.
        const rawBody = await readRaw(ctx.req)
        verifySignature(deps.ingest, rawBody, headerOf(ctx.req, SIGNATURE_HEADER))
        const delivery = parseDelivery(rawBody)
        const outcome = await ingest(deps.ingest, delivery)

        if (outcome.status === 'duplicate') {
          // 200, not 409. A redelivery is the producer doing exactly what at-least-once delivery
          // requires of it, and answering with an error would make the relay retry for ever.
          return { status: 200, body: { status: 'duplicate', eventId: delivery.envelope.id } }
        }
        if (outcome.status === 'erased') {
          return { status: 200, body: { status: 'erased', removed: outcome.removed } }
        }
        ctx.log.info('activity record written', {
          recordId: outcome.record.id,
          category: outcome.record.category,
          topic: delivery.envelope.topic,
        })
        return { status: 201, body: { status: 'recorded', record: toWire(outcome.record) } }
      },
    },
  ]

  return routes.map((route) => ({ ...route, pattern: compile(route.path) }))
}

/* ------------------------------------------------------------------ authorisation */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * Whose feed is being asked for.
 *
 * A user reads their own and nobody else's. An operator reads whoever they name. A service token
 * has no feed of its own — it must name a user, and it does not get to read the estate-wide feed
 * by omitting the parameter.
 */
function feedOwner(principal: Principal, requested: string | null): string {
  if (principal.kind === 'user') {
    if (requested !== null && requested !== principal.userId && !isAdmin(principal)) {
      throw new ForbiddenError('acting for another user')
    }
    return isAdmin(principal) && requested !== null ? requested : principal.userId
  }
  if (requested === null) throw new BadRequestError('a service token must name a userId')
  return requested
}

function requireReadAccess(principal: Principal, record: ActivityRecord): void {
  if (isAdmin(principal)) return
  if (record.visibility === 'internal') {
    // Not a 404: the record exists and an operator can see it. Pretending otherwise would make
    // an operator's own investigation harder for no gain — the id is already unguessable.
    throw new ForbiddenError('role:admin')
  }
  if (principal.kind === 'service') return
  if (record.userId !== null && record.userId === principal.userId) return
  throw new ForbiddenError('the owner of the record, or role:admin')
}

/* ------------------------------------------------------------------ parsing */

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new BadRequestError(`limit must be a whole number between 1 and ${MAX_PAGE_SIZE}`)
  }
  return value
}

/**
 * A category filter.
 *
 * A user may filter by any of the sixteen. `unclassified` is not one of them and is available
 * only to an operator — it is the backlog of topics this build predates, not a part of the
 * product's own vocabulary.
 */
function parseCategory(raw: string | null, operator: boolean): StoredCategory | undefined {
  if (raw === null) return undefined
  if (!isStoredCategory(raw) || (raw === 'unclassified' && !operator)) {
    throw new BadRequestError(`category must be one of: ${CATEGORIES.join(', ')}`)
  }
  return raw
}

/** The producing service. Bounded so a filter cannot become an unbounded scan. */
function parseProduct(raw: string | null): string | undefined {
  if (raw === null) return undefined
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(raw)) throw new BadRequestError('product must be a service name')
  return raw
}

function toWire(record: ActivityRecord): Record<string, unknown> {
  return {
    id: record.id,
    userId: record.userId,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
    category: record.category,
    type: record.type,
    subjectUrn: record.subjectUrn,
    summary: record.summary,
    amount: record.amount,
    assetCode: record.assetCode,
    correlationId: record.correlationId,
    sourceEventId: record.sourceEventId,
    sourceTopic: record.sourceTopic,
    product: record.producer,
    visibility: record.visibility,
  }
}

function toPage(page: { records: readonly ActivityRecord[]; nextCursor?: string }): Record<string, unknown> {
  return {
    records: page.records.map(toWire),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

/* ------------------------------------------------------------------ transport */

/**
 * The exact bytes that arrived, as a string.
 *
 * Not parsed and re-serialised. The signature is over these bytes, and a re-serialisation differs
 * on key order, whitespace and number formatting — so verifying anything else would be verifying
 * something other than what the handler acts on.
 */
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
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

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Exported for the test that asserts the column constraint and this list agree. */
export const FEED_CATEGORIES: readonly StoredCategory[] = STORED_CATEGORIES
