/**
 * Ingest: the only way a record is ever created.
 *
 * AD-11: **written only from the event bus.** No product writes here directly, because a direct
 * write is a write that can happen without the domain change having committed — a feed entry
 * saying a deposit was credited, for a transaction that rolled back. If it is not worth an outbox
 * row, it is not worth a feed entry. That is why there is no `POST /records` on this service and
 * why `POST /ingest` takes a signed envelope rather than a record.
 *
 * ## Two checks, and they answer different questions
 *
 * A service token says **who is calling**. The delivery signature says **the body was not altered
 * between the producer's outbox and this handler**. Neither implies the other: a token proves
 * nothing about the bytes, and a signature proves nothing about which of the estate's services is
 * on the other end of the socket. Both are required, and the signature is verified over the raw
 * request bytes before anything parses them — the ordering is the point, since a parser is an
 * attack surface reachable by anyone who can open a socket.
 *
 * `verifyDelivery` comes from `@cloudsforge/contracts-events` and is not reimplemented here. It
 * takes a **list** of secrets so a rotation is a window rather than an instant, it puts the
 * timestamp inside the signed message so the freshness window means something, and every
 * comparison in it is timing-safe.
 *
 * ## An unknown topic is filed, never dropped — but it is still held to the envelope contract
 *
 * A consumer that meets a topic added after its copy of contracts-events was published is a
 * normal consequence of deploying twenty-two services independently. Dropping the event is the
 * one response that is definitely wrong: it is gone, and nothing records that it arrived. So the
 * envelope is quarantined as `unclassified`, with its payload kept, and it can be reclassified
 * later from data that was never thrown away.
 *
 * **Quarantine excuses ONE fact and no others: that this build's registry is behind.** It has
 * never been an excuse for a malformed envelope, and for a while it was — see `parseDelivery`.
 */

import {
  DELIVERY_TOLERANCE_MS,
  classifyEnvelope,
  verifyDelivery,
  type DeliveryFailure,
  type EventEnvelope,
} from '@cloudsforge/contracts-events'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { classify } from './classify.ts'
import { eraseUser, insertRecord, type ActivityRecord, type Db } from './records.ts'

export class DeliverySignatureError extends Error {
  readonly reason: DeliveryFailure | 'missing'
  constructor(reason: DeliveryFailure | 'missing') {
    super(`the delivery signature was refused: ${reason}`)
    this.name = 'DeliverySignatureError'
    this.reason = reason
  }
}

export class MalformedEventError extends Error {
  readonly errors: readonly string[]
  constructor(errors: readonly string[]) {
    super(`the delivered body is not an event envelope: ${errors.join('; ')}`)
    this.name = 'MalformedEventError'
    this.errors = errors
  }
}

export interface IngestDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly secrets: readonly string[]
  readonly toleranceMs?: number
  /** A seam, so the lag histogram and the freshness window can both be tested. */
  readonly now?: () => number
}

/**
 * Verify the signature over the raw bytes.
 *
 * The body is passed as the exact string that arrived, not a re-serialisation of a parsed object:
 * `JSON.stringify(JSON.parse(body))` differs from `body` on key order, whitespace and number
 * formatting, and any of those would make a valid signature fail — or, far worse, make an
 * implementation drift towards verifying something other than what it acted on.
 */
export function verifySignature(deps: IngestDeps, rawBody: string, header: string | undefined): void {
  if (!header) throw new DeliverySignatureError('missing')
  const verification = verifyDelivery(rawBody, header, deps.secrets, {
    now: deps.now?.() ?? Date.now(),
    toleranceMs: deps.toleranceMs ?? DELIVERY_TOLERANCE_MS,
  })
  if (!verification.ok) throw new DeliverySignatureError(verification.reason)
  if (verification.keyIndex > 0) {
    // Non-zero means the endpoint is still accepting a rotated-out key. Worth knowing about: a
    // rotation that is never finished is a secret that is never actually retired.
    deps.logger.warn('delivery verified against a rotated-out secret', { keyIndex: verification.keyIndex })
  }
}

export interface ParsedDelivery {
  readonly envelope: EventEnvelope
  /** False when the topic is well-formed but this build's registry has never heard of it. */
  readonly known: boolean
}

/**
 * Parse a delivered body into an envelope.
 *
 * `classifyEnvelope` from contracts-events, and nothing else. The envelope contract is owned there
 * and is never restated here — that is the whole of this function now, and it used not to be.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **QUARANTINE-WITHOUT-VALIDATION WAS A DEFECT, AND IT WAS THIS SERVICE'S.**
 *
 * This function used to hand-roll a shorter checklist for an unregistered topic — id, key,
 * occurredAt, producer, correlationId, payload — on the stated grounds that it was "the minimum a
 * quarantine row needs". The reasoning was sound about rows and wrong about events. It omitted
 * `actor` and `version` entirely. So an unregistered topic got a **free pass on envelope
 * correctness**, and the pass was silent: the row landed, `unclassified`, looking exactly like a
 * consumer that is merely behind.
 *
 * That is not hypothetical. `devplatform` shipped two illegal actors — `actorOf` spelled an
 * API-key caller `key:<display>`, and the organisation-erasure path passed `system:identity`,
 * neither of which is an `ActorKind` (`system` is the one kind that takes no subject at all). Every
 * envelope on both paths was one the contract refuses. Nothing in the estate said so, because
 * `devplatform.key.revoked` was unregistered here and this function waved it through. The day
 * `micro-contracts` `8889373` registered three topics in one commit, both those paths would have
 * started being refused at once — **by a commit that touched no producer at all.**
 *
 * One check is still out of reach here and is named rather than implied: for an unregistered topic
 * there is no `TopicSpec`, so nothing can say whether the producer owns the namespace it published
 * under. That check arrives with the registration, and only with it.
 *
 * The excusal quarantine is for is exactly one fact: *this build's registry is behind its
 * producers*. A malformed envelope is a different fact with a different remedy — a producer bug, to
 * be fixed today — and `classifyEnvelope` exists precisely so the two are not collapsed. So an
 * unregistered topic is now held to every rule a registered one is held to, and only the missing
 * registration is forgiven. A producer whose envelope is illegal learns on its first delivery
 * instead of on somebody else's release day.
 *
 * **This refuses events that were previously stored, and that is the intended trade.** A 400 is not
 * a silent drop: the relay retries, the failure is counted, and it names every defect at once. The
 * loss quarantine protects against is *nobody ever knowing the event existed*; a producer being
 * told its envelope is illegal is the opposite of that.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function parseDelivery(rawBody: string): ParsedDelivery {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch (err) {
    throw new MalformedEventError([`not JSON (${err instanceof Error ? err.message : String(err)})`])
  }

  const verdict = classifyEnvelope(parsed)
  if (verdict.ok) return { envelope: verdict.value, known: true }
  if (verdict.reason === 'unregistered_topic') {
    // The one excusal. `defects` is empty by construction on this branch — the envelope is
    // contract-clean and the only thing wrong with it is that this build has never heard of the
    // topic. Quarantine it, keep the payload, and let a later release reclassify the row.
    return { envelope: parsed as EventEnvelope, known: false }
  }
  // Every other defect, including on an unregistered topic. `verdict.defects` deliberately omits
  // the "not in this registry" message: being behind a producer is never this service's caller's
  // fault, and reporting it would send a producer to fix a release it does not own.
  throw new MalformedEventError(verdict.defects)
}

/** Shared empty list, so the three branches that redact nothing do not each allocate one. */
const NONE: readonly string[] = Object.freeze([])

export type IngestOutcome =
  | { readonly status: 'recorded'; readonly record: ActivityRecord }
  | { readonly status: 'duplicate' }
  | { readonly status: 'erased'; readonly removed: number }

/**
 * Record one event, exactly once.
 *
 * The inbox insert and the record insert share one transaction, so a handler that fails leaves no
 * inbox row and the redelivery is processed rather than swallowed — which is the mistake that
 * makes a naive "record then handle" dedupe lose events. AD-10.
 */
export async function ingest(deps: IngestDeps, delivery: ParsedDelivery): Promise<IngestOutcome> {
  const { envelope, known } = delivery
  const receivedAt = deps.now?.() ?? Date.now()

  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${envelope.topic}, ${envelope.id})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) {
      return { result: { status: 'duplicate' } as IngestOutcome, redactedKeys: NONE }
    }

    const classified = classify(envelope, known)

    /**
     * Erasure, and the reason it writes no feed entry.
     *
     * The topic registry calls `identity.user.deleted` "FIRST. Erasure. Every service holding
     * user_id must acknowledge within the SLA", and this service holds a permanent, itemised
     * narrative of that user's money. Writing "your account was deleted" into the feed of a user
     * who no longer exists would leave behind a row keyed on the user id we were told to forget,
     * in a table nobody can read — personal data retained for no purpose, which is the definition
     * of the thing being asked for. The inbox row is the acknowledgement.
     */
    if (envelope.topic === 'identity.user.deleted' && classified.userId !== null) {
      const removed = await eraseUser(tx, classified.userId)
      return { result: { status: 'erased', removed } as IngestOutcome, redactedKeys: NONE }
    }

    // `classified.payload` and NOT `envelope.payload`. This line used to write the producer's whole
    // domain payload verbatim, with no allowlist and no redaction, into a column nothing ever
    // deleted — see the header of `redact.ts` for what that stored the week it was fixed. The
    // redaction is part of classifying an event precisely so that this call site cannot reach round
    // it, and neither can the next one.
    const record = await insertRecord(tx, {
      ...classified,
      occurredAt: envelope.occurredAt,
      correlationId: envelope.correlationId,
      sourceEventId: envelope.id,
      sourceTopic: envelope.topic,
      producer: envelope.producer,
    })
    // Null means the unique constraint on `source_event_id` refused it. That can only happen if
    // the same event id arrived under a different topic, which is a producer bug — but the answer
    // is still "we already have it", not a 500 and a redelivery loop.
    if (!record) return { result: { status: 'duplicate' } as IngestOutcome, redactedKeys: NONE }
    return { result: { status: 'recorded', record } as IngestOutcome, redactedKeys: classified.redactedKeys }
  })

  const result = outcome.result

  if (result.status === 'duplicate') {
    // Expected under at-least-once delivery, so it is counted rather than logged at a level that
    // wakes anybody. A rate that climbs means a producer is not marking deliveries as delivered.
    deps.metrics.increment('activity_duplicates_dropped_total')
    return result
  }

  // How far behind the fact this service is. Measured from `occurredAt` — when the thing
  // happened — rather than from when the relay sent it, because a relay that is stuck for an
  // hour is exactly the outage this metric exists to show.
  const lagSeconds = Math.max(0, (receivedAt - Date.parse(envelope.occurredAt)) / 1_000)
  deps.metrics.observe('activity_ingest_lag_seconds', lagSeconds, { producer: envelope.producer })

  if (result.status === 'erased') {
    deps.logger.info('user erased from the activity feed', {
      removed: result.removed,
      correlationId: envelope.correlationId,
    })
    return result
  }

  deps.metrics.increment('activity_records_total', { category: result.record.category })

  /**
   * How many payload keys the allowlist refused, by topic.
   *
   * A counter and not a log line, and that is a decision rather than laziness: most topics send
   * fields this build does not read, so a warning per delivery would be constant noise and would
   * be muted within a week — and a muted signal is the same as no signal. What an operator needs
   * is the *change*: a topic whose dropped-key rate moves is a producer that started sending
   * something new, which is the exact event that used to be invisible. The key NAMES are on the
   * row itself, under `__redacted`, so "which key" is one query away and never a log of values.
   *
   * Cardinality is bounded by the topic registry, which is a closed set of about sixty.
   */
  if (outcome.redactedKeys.length > 0) {
    deps.metrics.increment(
      'activity_payload_keys_dropped_total',
      { topic: envelope.topic },
      outcome.redactedKeys.length,
    )
  }

  if (result.record.category === 'unclassified') {
    // Loud, because it is a backlog rather than a normal outcome: this build is behind its
    // producers and somebody has to add a classifier.
    deps.logger.warn('an event was quarantined as unclassified', {
      topic: envelope.topic,
      eventId: envelope.id,
      producer: envelope.producer,
    })
  }
  return result
}
