/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template: the parts that matter — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent,
 * and a template that imports a framework decides for twenty-two services that have not been
 * written yet.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because the identity service is having a bad minute.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WAVE M2: THE REQUEST LIFECYCLE MOVED OUT AND THE ROUTES STAYED.**
 *
 * The matcher, the request id, the network attribution, the in-flight gauge and the two RED
 * metrics used to be in this file and are now `../kernel.ts`, shared with the module this one is
 * mounted beside. Two copies of that code in one process is the thing most worth not having: they
 * agreed line for line, and the first time they stopped agreeing the difference would be invisible.
 *
 * What changed shape here, and nothing else did:
 *
 *   * **Every handler closes over `deps` instead of taking it as a parameter.** Two modules in one
 *     process do not share one dependency bag — this one holds `NOTIFY_INGEST_SIGNING_SECRET` and
 *     the SMTP pipeline, the other holds `ACTIVITY_INGEST_SECRETS` — so a `deps` parameter threaded
 *     by the kernel would have to be a union of the two.
 *   * **`ctx.param` became `idOf(ctx)`**, because the shared matcher names its parameters. Same
 *     decode, same single `:id` segment, and a malformed percent-escape is now a 400 rather than a
 *     `URIError` thrown inside the request listener — see `idOf`.
 *   * **`POST /ingest` became `POST /ingest/notify`.** Both merged modules mounted `/ingest` and
 *     they verify it with different secrets. See `NOTIFY_INGEST_PATH`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The ingest path is authenticated by a signature, and by nothing else
 *
 * An HMAC over the raw body. It proves the body was produced by something holding the ingest
 * secret, and carries a timestamp inside the signed message so a captured request expires. The
 * signature is verified over the **raw bytes**, before parsing. Verifying a re-serialised object
 * would compare a MAC over bytes nobody sent.
 */

import type { IncomingMessage } from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import type { Server } from 'node:http'
import { isKnownTopic } from './catalogue.ts'
import { SIGNATURE_HEADER, readInboundEvent, verifyDelivery } from './events.ts'
import { INGESTED_TOTAL } from './metrics.ts'
import {
  CATEGORIES,
  DELIVERY_STATES,
  isCategory,
  isChannel,
  isDigest,
  isPriority,
  type Channel,
  type DeliveryState,
} from './model.ts'
import { ingestEvent, type PipelineDeps } from './pipeline.ts'
import type { Preference } from './routing.ts'
import type { Db, Notification, NotifyStore } from './store.ts'
import { describeNotification, isTemplateId, templateFor } from './templates.ts'
import {
  errorReply,
  headerOf,
  mountRoutes,
  type MountDeps,
  type Reply,
  type RequestContext,
  type RouteSpec,
} from '../kernel.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

/**
 * Everything this module's routes need.
 *
 * Extends the kernel's `MountDeps` — the logger, the metrics and the per-network selector — so the
 * same bag serves both `createRoutes` and `mountRoutes` while the kernel's own type still cannot
 * see the store, the pipeline or the ingest secrets.
 */
export interface ServerDeps extends MountDeps {
  readonly lifecycle: Lifecycle
  readonly verifier: PrincipalVerifier
  readonly store: NotifyStore
  readonly pipeline: PipelineDeps
  /** Candidates for the ingest signature. A list so a rotation does not need a flag day. */
  readonly ingestSecrets: readonly string[]
  /** Enqueue a broadcast fan-out. Injected so a route never reaches the job queue directly. */
  readonly enqueueBroadcast: (broadcastId: string) => Promise<void>
  readonly enqueueDispatch: () => Promise<void>
  /**
   * Refresh sampled gauges immediately before `/metrics` renders.
   *
   * Queue depth is a value that must be read, not counted, and reading it on a timer would be the
   * one `setInterval` in this repository — the shape rule 8 exists to keep out. A scrape is
   * already periodic, so the scrape is when to sample.
   */
  readonly beforeScrape?: () => Promise<void>
  /** Test seam for the signature's freshness window. */
  readonly now?: () => number
}

/**
 * The scope a service token must carry to read on a user's behalf.
 *
 * There is deliberately no INGEST_SCOPE any more. The §3.3p repair made the ingest path MAC-only —
 * a relay is a background job with no bearer and no way to mint one — so `notify:ingest` was a
 * scope no gate demanded and no token could ever usefully hold. A dead scope constant is worse
 * than none: it reads as a capability, and registering it would have made identity able to mint
 * a credential that opens nothing.
 */
export const READ_SCOPE = 'notify:read'

/**
 * This module's event-bus inbox.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **IT WAS `POST /ingest`, AND IT COULD NOT STAY THERE.**
 *
 * Wave M2 puts this module in activity's process, and activity mounted the same path. The two
 * verify with DIFFERENT secrets — `NOTIFY_INGEST_SIGNING_SECRET` here, `ACTIVITY_INGEST_SECRETS`
 * there — so one mount would have to accept either, and accepting either makes each secret a
 * credential for both sinks: the key that mints a "your key was exported" email would also write
 * the canonical record of what happened to a user's money. The full argument, and the three other
 * reasons one shared mount cannot work, is in `../routes.ts`'s `INGEST_PATHS`.
 *
 * **Every producer subscription in the estate names the old path verbatim and must be re-pointed.**
 * That is the wave's one genuinely breaking change, and it is why the merge plan's promise that
 * "the retired service's Service becomes a CNAME so no caller changes on cutover day" does not
 * hold for M2: a CNAME moves a host, and this is a path.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const NOTIFY_INGEST_PATH = '/ingest/notify'

const MAX_BODY_BYTES = 256 * 1024
const MAX_PAGE = 100
const DEFAULT_PAGE = 25

/* ------------------------------------------------------------------ plumbing */

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/**
 * Wrap one handler so a thrown failure becomes the reply it deserves.
 *
 * This is the former `handle`: it used to sit between the listener and the route table and wrapped
 * ROUTING as well as the route. Now that a spec is one closure, the wrap is per handler — the
 * mapping itself is unchanged.
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

/** Map a thrown failure to the reply it deserves. Byte for byte the mapping this file had. */
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
    ctx.log.error('token verifier unavailable', { err })
    return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
  }
  if (err instanceof BadRequestError) {
    return errorReply(400, 'bad_request', err.message, ctx.requestId)
  }
  ctx.log.error('unhandled request failure', { err })
  return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
}

/**
 * The `:id` segment, decoded.
 *
 * The matcher this file used to carry decoded the segment itself, inside the request listener and
 * outside any promise — so `%zz` raised a `URIError` that reached `uncaughtException` rather than
 * the client. It is decoded here instead, where a throw is already a mapped 400. Same value on
 * every input that used to work; the only behaviour that changed is the one that took the process
 * down.
 */
function idOf(ctx: RequestContext<Db>): string | null {
  const raw = ctx.params['id']
  if (raw === undefined) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new BadRequestError('the id in the path is not valid percent-encoding')
  }
}

/* ------------------------------------------------------------------ routes */

/**
 * Every route this module serves, each handler already closed over `deps`.
 *
 * The list is otherwise exactly what `buildRoutes` returned: same methods, same order, and the same
 * paths apart from the ingest split named at `NOTIFY_INGEST_PATH`.
 *
 * The three operational routes are declared HERE and filtered out at the module seam — see
 * `module.ts`'s `mountableRoutes`. They are kept in this table because it is also the table
 * `createServer` mounts, which is the surface `server.test.ts` drives on its own.
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
     * every time the database blinks, turning a brief outage into a rolling restart of the
     * whole estate. Readiness is where dependencies belong.
     */
    define('GET', '/livez', async () => ({ status: 200, body: deps.lifecycle.livez() })),

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

    /* ------------------------------------------------------------- the user's own */

    define('GET', '/notifications', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      // Three authorities, one line. An operator with the admin role may read anyone; a service
      // reads whoever its call names; a user reads only itself, and `subjectUserId` throws
      // ForbiddenError — mapped to 403 above — if it asks for another.
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)

      const done = deps.lifecycle.track()
      try {
        const page = await deps.store.listNotifications(userId, {
          limit: pageSize(ctx),
          cursor: ctx.url.searchParams.get('cursor'),
          unreadOnly: ctx.url.searchParams.get('unread') === 'true',
        })
        return {
          status: 200,
          body: { ...page, notifications: page.notifications.map(readable) },
        }
      } finally {
        done()
      }
    }),

    define('POST', '/notifications/:id/read', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      const userId = subjectUserId(principal)
      const id = idOf(ctx)
      if (!id) throw new BadRequestError('a notification id is required')
      const done = deps.lifecycle.track()
      try {
        const notification = await deps.store.markRead(userId, id)
        // 404 rather than 403 for someone else's notification. The scoping is in the WHERE
        // clause, so this route cannot distinguish "does not exist" from "not yours" — and
        // telling a caller which of the two it is confirms that an id exists.
        if (!notification) {
          return errorReply(404, 'not_found', 'no such notification', ctx.requestId)
        }
        return { status: 200, body: { notification: readable(notification) } }
      } finally {
        done()
      }
    }),

    define('GET', '/preferences', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      const preferences = await deps.store.listPreferences(userId)
      return {
        status: 200,
        body: {
          preferences,
          categories: CATEGORIES,
          /**
           * Stated in the response, not just on the page. A client that renders preferences
           * has to be able to say which categories it cannot switch off, and FEA-41 requires
           * the unsubscribe path to say so too. Deriving it in the client would be a second
           * copy of §10.3 that can disagree with this one.
           */
          alwaysDelivered: {
            priority: 'critical',
            note:
              'Critical security notifications — a new device, a password or two-factor change, ' +
              'a key export, a withdrawal — are always delivered on at least one channel and ' +
              'cannot be switched off.',
          },
        },
      }
    }),

    define('PUT', '/preferences', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(
        principal,
        typeof body['userId'] === 'string' ? (body['userId'] as string) : undefined,
      )
      const preferences = parsePreferences(body['preferences'])
      const done = deps.lifecycle.track()
      try {
        const saved = await deps.store.upsertPreferences(userId, preferences)
        ctx.log.info('preferences updated', { userId, count: preferences.length })
        return { status: 200, body: { preferences: saved } }
      } finally {
        done()
      }
    }),

    /* ------------------------------------------------------------- ingest */

    define('POST', NOTIFY_INGEST_PATH, async (ctx) => {
      // THE SIGNATURE IS THE AUTHENTICATION — the same repair as micro-activity's inbox, for
      // the same structural reason. This handler used to authenticate a bearer and demand
      // `notify:ingest`, and no producer could ever present one: every outbox relay in the
      // estate sends the HMAC signature and NO Authorization header (see identity's
      // `outbox.ts` deliver()) — a relay is a background job with no bearer and no way to mint
      // one. So every event bound for a person's notifications died 401 at this line, always.
      // The MAC over the raw bytes is a shared-secret proof over exactly what was sent, which
      // a bearer is not; a signed-in person still cannot reach this route, because a person
      // does not hold the outbox signing secret. `trade` and `worlds` shaped their inboxes
      // this way from the start.
      //
      // `deps.ingestSecrets` is THIS module's bag and holds only `NOTIFY_INGEST_SIGNING_SECRET`.
      // There is no expression in this closure that can reach activity's.

      // Raw bytes, because the signature is over exactly what was sent.
      const raw = await readRaw(ctx.req)
      const presented = headerOf(ctx.req, SIGNATURE_HEADER)
      if (!presented) throw new BadRequestError(`the ${SIGNATURE_HEADER} header is required`)

      const verification = verifyDelivery(raw, presented, deps.ingestSecrets, {
        ...(deps.now ? { now: deps.now() } : {}),
      })
      if (!verification.ok) {
        // 401, not 400. A bad signature is a failure to authenticate the *body*, and answering
        // 400 would tell a prober that the signature is checked but the payload is not.
        ctx.log.warn('ingest signature rejected', { reason: verification.reason })
        return errorReply(401, 'bad_signature', 'the delivery signature is not valid', ctx.requestId)
      }
      if (verification.keyIndex > 0) {
        // The producer is still using a rotated-out secret. Not an error yet; a countdown.
        ctx.log.warn('ingest signed with a superseded secret', { keyIndex: verification.keyIndex })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new BadRequestError('request body is not valid JSON')
      }

      const read = readInboundEvent(parsed, isKnownTopic)
      if (!read.ok) {
        deps.metrics.increment(INGESTED_TOTAL, { outcome: read.kind })
        ctx.log.warn('event rejected', { kind: read.kind, errors: read.errors })
        // 202 for an unreadable version, 400 for a malformed body. A producer sending a major
        // version this build cannot read is not making a bad request — the deploy ran in the
        // wrong order — and answering 400 would make it retry for ever.
        return read.kind === 'unreadable_version'
          ? { status: 202, body: { accepted: false, reason: 'unreadable_version', errors: read.errors } }
          : errorReply(400, 'bad_event', read.errors.join('; '), ctx.requestId)
      }
      if (read.registryLag) {
        ctx.log.warn('event on a topic missing from this build of contracts-events', {
          topic: read.event.topic,
        })
      }

      const done = deps.lifecycle.track()
      try {
        // The estate travels with the event, onto every delivery it creates.
        const outcome = await ingestEvent(deps.pipeline, read.event, ctx.network)
        deps.metrics.increment(INGESTED_TOTAL, { outcome: outcome.kind })
        // Pull the dispatcher forward so a critical notification is not waiting on a poll.
        if (outcome.kind === 'processed' && outcome.created.length > 0) {
          await deps.enqueueDispatch()
        }
        // Always 202. The event is durably recorded; whether it produced a notification is a
        // domain answer, not an HTTP one, and a producer must not retry because a rule decided
        // an event was not notifiable.
        return { status: 202, body: { accepted: true, outcome } }
      } finally {
        done()
      }
    }),

    /* ------------------------------------------------------------- operator */

    define('POST', '/admin/broadcasts', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const body = await readJson(ctx.req)

      const templateId = typeof body['templateId'] === 'string' ? body['templateId'] : 'system.broadcast'
      if (!isTemplateId(templateId)) throw new BadRequestError(`unknown template: ${templateId}`)
      if ((templateFor(templateId).secretParams ?? []).length > 0) {
        // A template that carries a single-use credential renders whatever `params` it is handed,
        // and this route takes `params` from the request body untouched. The scheme guard that
        // refuses a `javascript:` link lives in the catalogue rule, on the ingest path where
        // the value comes from a signed producer event — nothing here goes near it. So this would
        // let an operator, or a stolen admin token, mail every reachable user a link of their
        // choosing under a subject line that says CloudsForge minted it: the most convincing
        // phishing message the estate is capable of sending, sent by the estate.
        //
        // Refused by the property rather than by the id, so the next credential-carrying template
        // is covered without anybody remembering this line.
        throw new BadRequestError(
          `${templateId} carries a single-use credential and cannot be broadcast; it is addressed to one person by the event that mints it`,
        )
      }
      const category = typeof body['category'] === 'string' ? body['category'] : 'system'
      if (!isCategory(category)) throw new BadRequestError(`unknown category: ${category}`)
      const priority = typeof body['priority'] === 'string' ? body['priority'] : 'normal'
      if (!isPriority(priority)) throw new BadRequestError(`unknown priority: ${priority}`)
      if (priority === 'critical') {
        // An operator broadcast that ignores every preference is a megaphone. The §10.3
        // exception exists for facts about a user's own account, not for announcements.
        throw new BadRequestError('a broadcast may not be critical; that priority is reserved for account security')
      }
      const params = isRecord(body['params']) ? body['params'] : {}
      const userIds = Array.isArray(body['userIds'])
        ? body['userIds'].filter((id): id is string => typeof id === 'string')
        : []
      const audience = userIds.length > 0 ? 'listed' : 'all'
      const dedupeKey =
        typeof body['dedupeKey'] === 'string' && body['dedupeKey'].length > 0
          ? body['dedupeKey']
          : `broadcast:${ctx.requestId}`

      const done = deps.lifecycle.track()
      try {
        const broadcast = await deps.store.insertBroadcast({
          category,
          priority,
          templateId,
          params,
          audience,
          userIds,
          dedupeKey,
          createdBy: principal.kind === 'user' ? `operator:${principal.userId}` : `service:${principal.service}`,
        })
        // Fanned out by a leased job, not in the request. A broadcast to every user is minutes
        // of work, and a route that does it inline is a route that times out and is retried.
        await deps.enqueueBroadcast(broadcast.id)
        ctx.log.info('broadcast queued', { broadcastId: broadcast.id, audience, priority })
        return { status: 202, body: { broadcast } }
      } finally {
        done()
      }
    }),

    /**
     * The dead-letter view — one view over every channel, developer webhooks included.
     *
     * Defaults to the terminal states, because "what did we fail to deliver" is the question
     * being asked. `?state=pending` widens it to "what is stuck".
     */
    define('GET', '/admin/deliveries', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)

      const requestedStates = ctx.url.searchParams.getAll('state')
      const user = ctx.url.searchParams.get('user')
      const address = ctx.url.searchParams.get('address')

      // ── THE DEFAULT DEPENDS ON THE QUESTION BEING ASKED ────────────────────────────────
      // Unfiltered, this is the dead-letter view and `dead, undeliverable` is right: an
      // operator asking "what is broken" does not want the healthy majority.
      //
      // Asked about ONE recipient it is a different question — "what did we send this person,
      // and did it arrive" — and the same default answers it wrongly in the worst way. Support
      // looks up a user who says they got nothing, sees an empty list, and concludes nothing
      // was sent, when in truth every message is sitting there in `sent`. An empty result that
      // means "no failures" is indistinguishable from one that means "no mail", and only one
      // of those is a reason to resend.
      const scoped = user !== null || address !== null
      const states: DeliveryState[] = requestedStates.length
        ? requestedStates.filter((state): state is DeliveryState =>
            (DELIVERY_STATES as readonly string[]).includes(state),
          )
        : scoped
          ? [...DELIVERY_STATES]
          : ['dead', 'undeliverable']
      if (states.length === 0) throw new BadRequestError('state must be one of ' + DELIVERY_STATES.join(', '))

      const channelParam = ctx.url.searchParams.get('channel')
      if (channelParam !== null && !isChannel(channelParam)) {
        throw new BadRequestError(`unknown channel: ${channelParam}`)
      }
      const channel: Channel | null = channelParam

      // Rejected rather than coerced. A `user` that is not a uuid would otherwise reach the
      // query as a cast that throws 500 deep in the driver, and the operator would read an
      // outage where they made a typo.
      if (user !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user)) {
        throw new BadRequestError('user must be a uuid')
      }

      const page = await deps.store.listDeliveries({
        states,
        channel,
        userId: user,
        address,
        limit: pageSize(ctx),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: page }
    }),

    /**
     * Send it again, as a new delivery beside the original.
     *
     * `202`, not `200`: nothing has been sent when this returns. The new row is `pending` and
     * the dispatcher picks it up on its own schedule, so a `200` would claim a delivery that
     * has not happened — the same lie `sent` would be if it were written here.
     *
     * `409` when there is nothing to resend, and the message says which of the two reasons it
     * is. Merging them into a 404 would tell an operator "no such delivery" about one that is
     * on screen in front of them.
     */
    define('POST', '/admin/deliveries/:id/resend', async (ctx) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)

      const id = idOf(ctx) ?? ''
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new BadRequestError('delivery id must be a uuid')
      }

      const created = await deps.store.resendDelivery(id)
      if (created === null) {
        return {
          status: 409,
          body: {
            error: {
              code: 'not_resendable',
              message:
                'no delivery with that id that can be resent — it is already pending, or the ' +
                'address it was addressed to has since been removed',
            },
          },
        }
      }
      deps.logger.info('delivery resent by an operator', { deliveryId: id, createdDeliveryId: created })
      return { status: 202, body: { deliveryId: created } }
    }),
  ]
}

/**
 * The listener, this module's routes only.
 *
 * Kept as its own export because every one of `server.test.ts`'s cases drives exactly this
 * surface: a module that could only be built inside the merged process would be a module nothing
 * could test alone.
 */
export function createServer(deps: ServerDeps): Server {
  return mountRoutes(createRoutes(deps), deps)
}

/* ------------------------------------------------------------------ helpers */

async function authenticate(ctx: RequestContext<Db>, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * A stored notification, plus the two fields a screen cannot compute for itself.
 *
 * `Notification` is what this service REMEMBERS; this is what it SAYS. The extra pair is derived
 * on the way out rather than stored, because a subject rewritten in `templates.ts` must change the
 * words on every row that has ever referenced it — a copy in the table would freeze the sentence
 * at the moment it was written and there would be no way to correct a typo in an old one.
 *
 * Additive, deliberately: every existing field keeps its name and shape, so a consumer reading the
 * old response is not broken by this and a consumer reading the new one does not have to wait for
 * a coordinated release. See `describeNotification` for why `href` can be null.
 */
export interface ReadableNotification extends Notification {
  readonly title: string
  readonly href: string | null
}

/**
 * The one place a stored row becomes something a caller can read.
 *
 * Both read routes go through it, for the same reason `toNotification` is the single redaction
 * point in `store.ts`: two mappers is one mapper away from a route that answers with a different
 * shape, and the one that would drift is always the one nobody looks at.
 */
function readable(notification: Notification): ReadableNotification {
  return {
    ...notification,
    ...describeNotification(notification.templateId, notification.params, notification.locale),
  }
}

function pageSize(ctx: RequestContext<Db>): number {
  const raw = ctx.url.searchParams.get('limit')
  if (!raw) return DEFAULT_PAGE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new BadRequestError(`limit must be a whole number between 1 and ${MAX_PAGE}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a preferences payload.
 *
 * Every field is checked against the closed set from `model.ts`, so an unknown channel is a 400
 * rather than a row the database rejects with a constraint violation the caller cannot read. The
 * `critical` exception is not enforced here because there is nothing to enforce: a preference
 * cannot express it. That is the design — §10.3 lives in routing and in two CHECK constraints,
 * not in a validation rule that a future route could forget.
 */
function parsePreferences(value: unknown): Preference[] {
  if (!Array.isArray(value)) throw new BadRequestError('preferences must be an array')
  if (value.length > 500) throw new BadRequestError('too many preferences in one request')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new BadRequestError(`preferences[${index}] must be an object`)
    const category = entry['category']
    if (typeof category !== 'string' || !isCategory(category)) {
      throw new BadRequestError(`preferences[${index}].category is not a known category`)
    }
    const channel = entry['channel']
    if (typeof channel !== 'string' || !isChannel(channel)) {
      throw new BadRequestError(`preferences[${index}].channel is not a known channel`)
    }
    const digest = entry['digest'] ?? 'instant'
    if (typeof digest !== 'string' || !isDigest(digest)) {
      throw new BadRequestError(`preferences[${index}].digest must be instant, hourly, daily or off`)
    }
    const minPriority = entry['minPriority'] ?? 'low'
    if (typeof minPriority !== 'string' || !isPriority(minPriority)) {
      throw new BadRequestError(`preferences[${index}].minPriority is not a known priority`)
    }
    const enabled = entry['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new BadRequestError(`preferences[${index}].enabled must be a boolean`)
    }
    return {
      category,
      channel,
      enabled: enabled ?? true,
      digest,
      minPriority,
    }
  })
}

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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new BadRequestError('request body must be a JSON object')
    return parsed
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}
