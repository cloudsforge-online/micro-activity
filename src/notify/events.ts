/**
 * Reading an inbound event.
 *
 * **This service consumes events and does not define them.** The envelope, the topic registry,
 * the version rule, the inbox key and the delivery signature all come from
 * `@cloudsforge/contracts-events` and are used, not restated. There is no local `EventEnvelope`
 * interface here and there must never be one: two spellings of an envelope is how a consumer ends
 * up reading a field the producer stopped sending.
 *
 * ## The one thing this file adds: tolerating a registry that lags
 *
 * `validateEnvelope` rejects an unregistered topic, and rightly: for most consumers a topic they
 * have never heard of is a bug. For notify it is a Tuesday. The fan-in is the entire bus, and
 * this service will always be the first consumer of a new topic. So a well-formed envelope on an
 * unregistered topic is accepted **only** when this service already holds a mapping rule for it,
 * and it is flagged so an operator can see the registry is behind.
 *
 * **This paragraph used to end differently, and the difference is the whole lesson.** It said the
 * rules naming unregistered topics were waiting on "services that will produce them", and listed
 * them: a password change, a deposit detected, a bot event, a risk limit, an offer, an auction, an
 * API-key event, a service incident. Every one of those services was written, and every one of
 * them emits a different name — so the tolerance stopped being a bridge to a registration and
 * became cover for eleven rules that could not fire. The mechanism below is unchanged and still
 * correct; what changed is that `topics.ts` now requires any rule using it to carry the spec that
 * will register the topic, so the lag is a state something is checking rather than a state nobody
 * can see. `knownTopic` is the same predicate it always was, and today it maps no unregistered
 * topic at all.
 *
 * The acceptance is keyed on the registry's own error string, reproduced once below, and
 * `events.test.ts` asserts the package still produces exactly it. If the package rewords that
 * message the test fails loudly and, until it is fixed, notify rejects unregistered topics — the
 * fail-closed direction.
 */

import {
  DELIVERY_TOLERANCE_MS,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPICS,
  acceptsVersion,
  isRegisteredTopic,
  isValidTopicName,
  parseTopicName,
  validateEnvelope,
  verifyDelivery,
  type EventEnvelope,
  type TopicName,
} from '@cloudsforge/contracts-events'

export { DELIVERY_TOLERANCE_MS, EVENT_ID_HEADER, SIGNATURE_HEADER, verifyDelivery }

/**
 * The registry's envelope with `topic` widened from `TopicName` to `string`.
 *
 * A widening, not a redefinition: every other field is the package's, and if the package adds one
 * it appears here without an edit. The widening is what lets a rule exist for a topic the
 * registry has not minted, which is the condition described above.
 */
export type InboundEvent = Omit<EventEnvelope<Record<string, unknown>>, 'topic'> & {
  readonly topic: string
}

/**
 * The exact error `validateEnvelope` produces for a well-formed but unregistered topic.
 *
 * Reproduced rather than imported because the package does not export it. `events.test.ts` pins
 * it, so the coupling is checked by a test instead of by hope.
 */
export function registryLagError(topic: string): string {
  return `topic: "${topic}" is not in this registry; contracts-events may be behind`
}

export type EventReadFailure =
  /** Not a well-formed envelope. Belongs in the rejection log. */
  | { readonly ok: false; readonly kind: 'malformed'; readonly errors: readonly string[] }
  /**
   * Well-formed, but at a major version this build cannot read. A different outcome from
   * `malformed` on purpose — the package's own comment makes the point: one tells an operator to
   * redeploy, the other to page the producer's owner.
   */
  | { readonly ok: false; readonly kind: 'unreadable_version'; readonly errors: readonly string[] }

export type EventReadResult =
  | {
      readonly ok: true
      readonly event: InboundEvent
      /** True when the topic is not in this build's copy of the registry. */
      readonly registryLag: boolean
    }
  | EventReadFailure

/**
 * Hyphens are legal in a `ProducerService` (`admin-api`) and illegal in a topic segment, so a
 * topic owned by such a service cannot pass the registry's own grammar. Normalising here lets
 * `admin_api.incident.opened` declare `producer: "admin-api"` and still be checked against its
 * namespace. See the note in README — this is a defect in the shared package, worked around at
 * one line rather than forked.
 */
function normaliseService(value: string): string {
  return value.replace(/-/g, '_')
}

/**
 * Validate a parsed body as an event this service can act on.
 *
 * `knownTopic` is the mapping table's membership test. Passing it in rather than importing the
 * catalogue keeps this module free of the domain, and makes the lag rule explicit at the call
 * site: an unregistered topic is accepted *because notify knows what to do with it*, never
 * merely because it parsed.
 */
export function readInboundEvent(
  value: unknown,
  knownTopic: (topic: string) => boolean,
): EventReadResult {
  const verdict = validateEnvelope(value)

  if (verdict.ok) {
    const envelope = verdict.value
    const spec = TOPICS[envelope.topic as TopicName]
    const version = acceptsVersion(envelope.version, spec.version)
    if (!version.accepted) {
      return {
        ok: false,
        kind: 'unreadable_version',
        errors: [`${envelope.topic}: ${version.reason} — ${version.detail}`],
      }
    }
    return { ok: true, event: asInbound(envelope), registryLag: false }
  }

  // Everything below is the registry-lag path, and it is deliberately narrow.
  const record = value as Record<string, unknown> | null
  const topic = typeof record?.['topic'] === 'string' ? (record['topic'] as string) : null
  if (topic === null || !isValidTopicName(topic) || isRegisteredTopic(topic)) {
    return malformed(verdict.errors)
  }
  if (!knownTopic(topic)) return malformed(verdict.errors)
  // The unregistered topic must be the ONLY thing wrong with it. A malformed actor on an
  // unregistered topic is still malformed.
  if (verdict.errors.length !== 1 || verdict.errors[0] !== registryLagError(topic)) {
    return malformed(verdict.errors)
  }

  // The registry normally enforces that a producer publishes only under its own namespace. It
  // cannot here, because there is no spec, so the check is done by hand rather than skipped:
  // a service publishing under another's prefix is a copy-paste or an impersonation.
  const parsed = parseTopicName(topic)
  const producer = record?.['producer']
  if (!parsed.ok || typeof producer !== 'string') return malformed(verdict.errors)
  if (normaliseService(producer) !== normaliseService(parsed.value.service)) {
    return malformed([`producer: "${producer}" does not own topic "${topic}"`])
  }

  return { ok: true, event: asInbound(record as unknown as EventEnvelope), registryLag: true }
}

function malformed(errors: readonly string[]): EventReadFailure {
  return { ok: false, kind: 'malformed', errors }
}

/** The payload is `unknown` on the envelope; a non-object payload becomes an empty one. */
function asInbound(envelope: EventEnvelope): InboundEvent {
  const payload = envelope.payload
  const usable =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return { ...envelope, topic: envelope.topic as string, payload: usable }
}
