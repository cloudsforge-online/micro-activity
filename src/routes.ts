/**
 * activity's route table, and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY HANDLER CLOSES OVER `deps`; NONE TAKES IT AS A PARAMETER.** `createRoutes` is called once
 * with this module's dependency bag and returns specs the kernel can mount without ever seeing the
 * verifier or the ingest secrets. That is what lets the notify module be mounted beside these
 * routes in one process with a bag of its own — see `kernel.ts`.
 *
 * It matters more here than it read in wave M1. The two bags hold DIFFERENT INGEST SECRETS:
 * `ACTIVITY_INGEST_SECRETS` authenticates a write to the canonical record of what happened to a
 * user's money, and `NOTIFY_INGEST_SIGNING_SECRET` authenticates minting a "your key was exported"
 * email. A `deps` parameter threaded by the kernel would have to be a union of the two, which is
 * one spread away from either handler holding the other's key.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------------------------
 * **There is no route here that creates a record from a product's request.**
 *
 * AD-11: activity is written only from the event bus. The ingest route takes a signed event
 * envelope, not a feed entry, and the difference is the whole design — a direct write is a write
 * that can happen without the domain change having committed, which is a feed entry describing a
 * transaction that rolled back. If it is not worth an outbox row, it is not worth a feed entry.
 * ---------------------------------------------------------------------------------------------
 */

import { SIGNATURE_HEADER } from '@cloudsforge/contracts-events'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  statusFor,
  type Principal,
} from '@cloudsforge/auth'
import type { IncomingMessage } from 'node:http'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { CATEGORIES, isStoredCategory, type StoredCategory } from './categories.ts'
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
import {
  errorReply,
  headerOf,
  type MountDeps,
  type Reply,
  type RequestContext,
  type RouteSpec,
} from './kernel.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

/**
 * Everything activity's routes need. Extends the kernel's `MountDeps` — which carries the logger,
 * the metrics and the per-network selector — so the same bag serves both `createRoutes` and
 * `mountRoutes` while the kernel's own type still cannot see anything below.
 */
export interface ServerDeps extends MountDeps {
  readonly lifecycle: Lifecycle
  readonly verifier: PrincipalVerifier
  readonly ingest: IngestDeps
  readonly beforeScrape?: () => Promise<void>
}

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * This module's event-bus inbox, and the path the estate's producers must name.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS IS NOT `/ingest` ANY MORE — WAVE M2's ONE UNAVOIDABLE BREAKING CHANGE.**
 *
 * Both merged services mounted `POST /ingest`, and they verify it with DIFFERENT SECRETS:
 * `ACTIVITY_INGEST_SECRETS` here, `NOTIFY_INGEST_SIGNING_SECRET` there. One process cannot serve
 * one path with two secret sets and stay honest, and the reasons are in `INGEST_PATHS`' note
 * below. So each module gets a path of its own, and the bare `/ingest` answers 410 naming both.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const ACTIVITY_INGEST_PATH = '/ingest/activity'

/**
 * The two inboxes this process serves, published in the 410 the retired path answers with.
 *
 * ── WHY NOT ONE MOUNT THAT TRIES BOTH SECRET SETS ─────────────────────────────────────────────
 *
 * It is the option that looks like compatibility and is a downgrade, on four counts:
 *
 *  1. **It makes each secret a credential for BOTH sinks.** Today `ACTIVITY_INGEST_SECRETS` can
 *     write the canonical record of a user's money and nothing else, and
 *     `NOTIFY_INGEST_SIGNING_SECRET` can mint a security email and nothing else. Accept either on
 *     one mount and whoever holds the weaker or older of the two holds both capabilities. The
 *     estate has already shipped one placeholder outbox key to 44 containers on 54 lines of a
 *     PUBLIC file; that exact event, repeated, would become a write to the money record.
 *  2. **It destroys rotation independence.** Both variables are accept-LISTS precisely so a
 *     rotation is not a flag day. Merged into one acceptance set, retiring one module's outgoing
 *     key silently widens or narrows the other's window, and "which secret is being retired" stops
 *     having an answer.
 *  3. **Nothing in the body says which sink it was for.** The two consumed-topic sets overlap
 *     almost entirely (~84 vs ~86 topics), and an envelope carries a topic, not a destination. One
 *     mount would therefore have to fan every accepted event to BOTH sinks — which would start
 *     notifying people about topics only the feed subscribes to — or guess.
 *  4. **The two handlers do not answer the same thing.** This one replies 201 with a record, or
 *     200 for a duplicate; notify's replies 202 with a pipeline outcome, always. One mount has to
 *     pick, and the loser's producers get a response contract they were not written against.
 *
 * And the failure mode of getting it wrong is silent in the worst direction: a producer configured
 * with the wrong secret would still be answered 2xx, and its events would land in the other
 * module's inbox.
 */
export const INGEST_PATHS: readonly string[] = ['POST /ingest/activity', 'POST /ingest/notify']

/* ------------------------------------------------------------------ plumbing */

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/**
 * Wrap one handler so a thrown failure becomes the reply it deserves.
 *
 * This is the former `handle`: it used to sit between the kernel and the route table and wrapped
 * ROUTING as well as the route. Now that a spec is one closure, the wrap is per handler — so the
 * mapping is unchanged and it no longer needs to be reachable from the kernel.
 */
function guarded(
  handle: (ctx: RequestContext<Db>) => Promise<Reply>,
): (ctx: RequestContext<Db>) => Promise<Reply> {
  return async (ctx) => {
    try {
      return await handle(ctx)
    } catch (err) {
      return mapFailure(err, ctx)
    }
  }
}

/** Map a thrown failure to the reply it deserves. Byte for byte the mapping `server.ts` had. */
function mapFailure(err: unknown, ctx: RequestContext<Db>): Reply {
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

/* ------------------------------------------------------------------ routes */

/**
 * Every route activity serves, each handler already closed over `deps`.
 *
 * The list is otherwise exactly what `buildRoutes` returned: same methods, same order, and the same
 * paths apart from the ingest split named above.
 */
export function createRoutes(deps: ServerDeps): readonly RouteSpec<Db>[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext<Db>) => Promise<Reply>,
  ): RouteSpec<Db> => ({ method, path, handle: guarded(handler) })

  return [
    /**
     * Static, deliberately. Liveness answers one question — should this process be killed and
     * restarted — and a liveness probe that consults a dependency restarts a healthy process
     * every time the database blinks. Readiness is where dependencies belong.
     */
    define('GET', '/livez', async () => ({ status: 200, body: deps.lifecycle.livez() })),

    /**
     * Readiness, for the WHOLE process.
     *
     * Since wave M2 this Lifecycle carries a hard probe for each module's database. A merged
     * `/readyz` that reported only activity's would answer 200 while every notification in the
     * estate was failing, and the balancer would keep sending traffic to it.
     */
    define('GET', '/readyz', async () => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx) => {
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
    }),

    define('GET', '/feed', async (ctx) => {
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
        const page = await listAllRecords(ctx.sql, {
          limit,
          ...(category ? { category } : {}),
          ...(product ? { product } : {}),
          ...(cursor ? { cursor } : {}),
        })
        return { status: 200, body: toPage(page) }
      }

      const userId = feedOwner(principal, requested)
      const page = await listFeed(ctx.sql, {
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
    }),

    define('GET', '/feed/:id', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID_PATTERN.test(id)) throw new BadRequestError('id must be a uuid')
      const record = await getRecord(ctx.sql, id)
      if (!record) throw new NotFoundError(`no activity record ${id}`)
      requireReadAccess(principal, record)
      return { status: 200, body: { record: toWire(record) } }
    }),

    /**
     * The only way a record is created.
     *
     * The order below is the security property: read the raw bytes, verify the signature over
     * exactly those bytes, and only then parse. Parsing first would put a parser in front of the
     * authentication, reachable by anyone who can open a socket.
     */
    define('POST', ACTIVITY_INGEST_PATH, async (ctx) => {
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
      //
      // `deps.ingest` is THIS module's bag and carries only `ACTIVITY_INGEST_SECRETS`. There is
      // no expression in this closure that can reach notify's.
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
    }),

    /**
     * The path both services used to serve, answering the one thing it can answer honestly.
     *
     * ════════════════════════════════════════════════════════════════════════════════════════
     * **410, AND IT READS NEITHER THE BODY NOR THE SIGNATURE.**
     *
     * This is the mount the two modules collided on, and the reason it is a hard refusal rather
     * than an alias is that every alternative fails SILENTLY in a direction somebody has to
     * diagnose:
     *
     *   * Aliasing it to this module's inbox answers 401 `bad_signature` to every notify
     *     producer — which reads as a rotated or broken secret, is the single most expensive
     *     misdiagnosis this estate makes, and an outbox relay retries a 401 for ever.
     *   * Aliasing it to notify's does the same to the feed, and a feed that silently stops is
     *     invisible until a user asks where their deposit went.
     *
     * A 410 naming both successors is the only answer that puts the fix in the response. It does
     * not verify anything first, deliberately: a refusal that ran the MAC would be an oracle for
     * which secret a given body was signed with.
     * ════════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/ingest', async (ctx) => {
      ctx.log.warn('post to the retired shared ingest path', {
        served: INGEST_PATHS,
        hint: 'wave M2 merged activity and notify into one process; the two inboxes now have paths of their own',
      })
      return {
        status: 410,
        body: {
          error: {
            code: 'ingest_path_split',
            message:
              'POST /ingest is gone. activity and notify now run in one process and their event-bus ' +
              'inboxes are separate paths, because they authenticate with different secrets: ' +
              `${INGEST_PATHS.join(' and ')}.`,
            served: INGEST_PATHS,
            requestId: ctx.requestId,
          },
        },
      }
    }),
  ]
}

/* ------------------------------------------------------------------ authorisation */

async function authenticate(ctx: RequestContext<Db>, deps: ServerDeps): Promise<Principal> {
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
