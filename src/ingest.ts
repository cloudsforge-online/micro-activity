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
 * ## An unknown topic is filed, never dropped
 *
 * A consumer that meets a topic added after its copy of contracts-events was published is a
 * normal consequence of deploying twenty-two services independently. Dropping the event is the
 * one response that is definitely wrong: it is gone, and nothing records that it arrived. So the
 * envelope is quarantined as `unclassified`, with its payload kept, and it can be reclassified
 * later from data that was never thrown away.
 */

import {
  DELIVERY_TOLERANCE_MS,
  isRegisteredTopic,
  isValidTopicName,
  validateEnvelope,
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
 * For a registered topic this is `validateEnvelope` from contracts-events and nothing else — the
 * envelope contract is owned there and is never restated here.
 *
 * For an unregistered one, `validateEnvelope` would reject the whole event over the topic alone,
 * which is exactly the drop this service must not do. The checks below are **not** a second copy
 * of that contract: they are the minimum a quarantine row needs — an id to dedupe on, a key, a
 * time to order by, a producer to attribute to, and a correlation id so the investigation that
 * eventually looks at it can get back to the request that caused it.
 */
export function parseDelivery(rawBody: string): ParsedDelivery {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch (err) {
    throw new MalformedEventError([`not JSON (${err instanceof Error ? err.message : String(err)})`])
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedEventError(['expected a JSON object'])
  }
  const record = parsed as Record<string, unknown>
  const topic = record['topic']

  if (typeof topic === 'string' && isValidTopicName(topic) && !isRegisteredTopic(topic)) {
    const errors: string[] = []
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (typeof record['id'] !== 'string' || !uuid.test(record['id'])) errors.push('id: expected a UUID')
    if (typeof record['key'] !== 'string' || record['key'] === '') errors.push('key: missing')
    const occurredAt = record['occurredAt']
    if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
      errors.push('occurredAt: expected an ISO-8601 instant')
    }
    if (typeof record['producer'] !== 'string' || record['producer'] === '') errors.push('producer: missing')
    if (typeof record['correlationId'] !== 'string' || record['correlationId'] === '') {
      errors.push('correlationId: missing; a cross-service investigation stops here')
    }
    if (!('payload' in record)) errors.push('payload: missing')
    if (errors.length > 0) throw new MalformedEventError(errors)
    return { envelope: record as unknown as EventEnvelope, known: false }
  }

  const validated = validateEnvelope(parsed)
  if (!validated.ok) throw new MalformedEventError(validated.errors)
  return { envelope: validated.value, known: true }
}

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
    if (claimed.length === 0) return { result: { status: 'duplicate' } as IngestOutcome }

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
      return { result: { status: 'erased', removed } as IngestOutcome }
    }

    const record = await insertRecord(tx, {
      ...classified,
      occurredAt: envelope.occurredAt,
      correlationId: envelope.correlationId,
      sourceEventId: envelope.id,
      sourceTopic: envelope.topic,
      producer: envelope.producer,
      payload: typeof envelope.payload === 'object' && envelope.payload !== null && !Array.isArray(envelope.payload)
        ? (envelope.payload as Record<string, unknown>)
        : { value: envelope.payload },
    })
    // Null means the unique constraint on `source_event_id` refused it. That can only happen if
    // the same event id arrived under a different topic, which is a producer bug — but the answer
    // is still "we already have it", not a 500 and a redelivery loop.
    if (!record) return { result: { status: 'duplicate' } as IngestOutcome }
    return { result: { status: 'recorded', record } as IngestOutcome }
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
