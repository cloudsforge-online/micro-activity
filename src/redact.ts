/**
 * THE PAYLOAD ALLOWLIST: what may be written to `activity_records.payload`, and what may not.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **UNTIL THIS FILE EXISTED, THE PRODUCING SERVICE DECIDED WHAT THIS SERVICE STORED FOR EVER.**
 *
 * `ingest.ts` wrote `envelope.payload` verbatim into a jsonb column, with no allowlist and no
 * redaction, on a table with no retention period. The failure mode that makes that a defect rather
 * than a shortcut is not a hypothetical: **a producer starts including a personal field in an event
 * payload, it is stored permanently, and no code anywhere notices.** There is no diff in this
 * repository on the day it happens. There is no test that goes red. The first person to find out is
 * whoever answers the subject access request.
 *
 * ## It happened while this was being written
 *
 * `identity.email.verification_requested` was registered in `contracts-events` and its payload is
 * (`identity/src/emailVerification.ts:172-185`):
 *
 *     { userId, handle, email, expiresAt, linkable, verifyUrl? }
 *
 * `email` is a direct identifier. `verifyUrl` is a **live single-use credential** — identity's own
 * header says so and accepts the trade for `notify`, which needs the link to send it and prunes its
 * rows. Activity subscribes to every domain topic (AD-11) and needs neither field for anything.
 * Under the old code both would have landed here, verbatim, in a row nothing deletes. That is the
 * whole argument for this file, and it arrived by itself.
 *
 * ## The rule for a KNOWN topic: a key not declared is not stored
 *
 * Every entry in `CLASSIFIERS` declares `payloadKeys`. The property is required by
 * `TopicClassifier`, and the table is `satisfies Readonly<Record<TopicName, TopicClassifier>>`, so
 * **a topic added without a declaration does not compile** — it cannot default to "store
 * everything", which is the property that makes this survive the next fifty topics.
 *
 * The declaration is deliberately *what this build reads*, not *what the producer sends*. That is
 * what makes migration 3's description of the column — "for a classified record it is the evidence
 * behind the summary" — true rather than aspirational, and it is checked both ways by
 * `THE RULE: a classifier may not read a payload key it has not declared`, which drives every
 * classifier against a recording Proxy: a key read but not declared fails, and a key declared but
 * never read fails too. Minimality is not a style preference here — an undeclared second party's id
 * left in a payload is a row that the erasure of *that* party can never reach.
 *
 * A declared key is still bounded, because a key allowlist says nothing about what the value holds:
 * strings are capped, and a nested object or array under a declared key is treated as undeclared
 * and reduced to its shape. Declaring `payload.details` must not be a way to declare everything.
 *
 * ## The rule for an UNKNOWN topic: shape survives, free text does not
 *
 * The quarantine is the dangerous path and it has no declaration to check against, by definition.
 * Both simple answers are wrong. Dropping the payload destroys the reclassification the quarantine
 * exists for — the record would be reduced to a topic name and a timestamp, and 04-domain-model's
 * promise that a quarantined row "can be reclassified from data that was never thrown away" would
 * be false. Keeping it verbatim is exactly the defect above, on the one path where this service has
 * the *least* idea what it is holding.
 *
 * The middle answer is that reclassification needs the payload's **shape and identifiers**, and
 * never its prose:
 *
 *   * Structure is preserved — every key name, at every depth, within bounds.
 *   * A value is kept only if its **syntax alone** proves it is not free text: a uuid, a
 *     `user:<uuid>`-style subject, a `urn:cloudsforge:` reference, an ISO-8601 timestamp, a decimal
 *     number, an asset code, a `0x` hash, a boolean, a number, or null.
 *   * Everything else is replaced by a descriptor naming its type and length — `"<string:31>"`.
 *
 * An email address, a postal address, a display name and a document reference all fail every one of
 * those shapes, and there is no producer change that can make them pass. An engineer writing the
 * missing classifier sees the full key structure and every identifier, which is what the job needs.
 *
 * **Short enum tokens are refused, and that is the cost, chosen deliberately.** `origin: 'external'`
 * and `outcome: 'razed'` are exactly the sort of value a reclassifier would like, and a rule that
 * kept short lowercase words would keep them. It would also keep `handle: 'savvaniss'` and
 * `firstName: 'anna'`, because a handle and a given name are **indistinguishable from an enum token
 * by shape** — and a handle is a direct identifier, not a hint. So the token is refused and
 * `"<string:8>"` is stored instead. The reclassifier loses nothing it cannot get from the producer's
 * own contract package, which is where the enum is defined and versioned in the first place.
 *
 * **Identifiers are kept on purpose, and erasure is the reason.** A uuid is personal data, so
 * keeping it needs a justification of its own: it is what lets `eraseUser` reach a quarantined row
 * that belongs to a user nobody ever attributed it to. Dropping the uuid would leave the rest of
 * the row behind with no way to find it — the defect would move rather than close. Keep the
 * identifier so there is something to destroy, and destroy it on request.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Where a redacted-away key list is recorded on the stored payload. Field names only, no values. */
export const REDACTED_MARKER = '__redacted'

/** Bounds. Every one of them is what stops a producer choosing this table's row size. */
const MAX_STRING = 512
const MAX_DEPTH = 4
const MAX_KEYS = 64
const MAX_ARRAY = 16
/** Listed in `__redacted`. Beyond this the count is reported instead of the names. */
const MAX_REPORTED_KEYS = 32

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `user:<uuid>`, `org:<uuid>` — a subject whose id half is a uuid, and no other spelling. */
const SUBJECT = /^[a-z]{1,16}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URN = /^urn:cloudsforge:[a-z0-9-]{1,32}:[a-z0-9_-]{1,32}:[A-Za-z0-9:_-]{1,64}$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?$/
const DECIMAL = /^-?\d{1,40}(?:\.\d{1,30})?$/
/**
 * An asset code, and the strictest of these patterns on purpose.
 *
 * It started as `classify.ts`'s column rule — `^[A-Z][A-Z0-9:_-]{0,31}$` — and a test caught what
 * that admits: `INTERNAL-4821` passes it, and so does a passport or document number, which is one
 * of the three things this file exists to keep out. An upper-case alphanumeric token with
 * separators IS the shape of a document reference, so the digits and the separators are gone and
 * the length is eight. `EMBER`, `SHARD`, `BTC`, `ETH` and `USDC` all pass; `ETH:USDC` passes as the
 * chain-qualified form.
 *
 * The cost is that a code with a digit in it (`1INCH`) reads as `<string:5>` in a QUARANTINED
 * payload. It is not the `asset_code` COLUMN — `classify.ts` fills that from the envelope and is
 * untouched — so what is lost is a shape hint on a topic nobody has classified yet, which is worth
 * less than the class of value this refuses.
 */
const ASSET_CODE = /^[A-Z]{2,8}(?::[A-Z0-9]{1,8})?$/
const HEX = /^0x[0-9a-f]{1,128}$/i

/**
 * Is this string's SYNTAX, on its own, proof that it is not free text?
 *
 * Syntax alone is the whole test, and it is why this is a closed list of patterns rather than a
 * denylist of things that look personal. A denylist has to predict the field a producer adds next.
 */
function isSafeString(value: string): boolean {
  if (value.length === 0) return true
  if (value.length > 128) return false
  return (
    UUID.test(value) ||
    SUBJECT.test(value) ||
    URN.test(value) ||
    ISO_8601.test(value) ||
    DECIMAL.test(value) ||
    ASSET_CODE.test(value) ||
    HEX.test(value)
  )
}

/** What a value's type and size were, when the value itself may not be kept. */
function describe(value: unknown): string {
  if (typeof value === 'string') return `<string:${value.length}>`
  if (Array.isArray(value)) return `<array:${value.length}>`
  if (typeof value === 'object' && value !== null) return `<object:${Object.keys(value).length}>`
  return `<${typeof value}>`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reduce a value to what may be stored without a declaration: structure, identifiers, no prose.
 *
 * Used for the whole of a quarantined payload, and for a nested value under a declared key — those
 * are the same problem, since a key allowlist bounds the key and says nothing about the document
 * hanging off it.
 */
function shapeOf(value: unknown, depth: number): unknown {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : describe(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return isSafeString(value) ? value : describe(value)
  if (depth >= MAX_DEPTH) return describe(value)
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((item) => shapeOf(item, depth + 1))
    return value.length > MAX_ARRAY ? [...kept, `<array:${value.length}>`] : kept
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    let n = 0
    for (const key of Object.keys(value)) {
      if (n >= MAX_KEYS) {
        out[REDACTED_MARKER] = `<keys:${Object.keys(value).length}>`
        break
      }
      out[key] = shapeOf(value[key], depth + 1)
      n += 1
    }
    return out
  }
  // A function or a symbol cannot arrive through `JSON.parse`, so this is unreachable from the
  // wire. It is here because "unreachable" is a claim about today's callers, not about the type.
  return describe(value)
}

/** A declared key's value: kept, but bounded. A string is capped; a document is reduced to shape. */
function boundDeclared(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING - 1)}…`
  }
  if (isPlainObject(value) || Array.isArray(value)) return shapeOf(value, 1)
  return value
}

export interface Redaction {
  /** Exactly what will be written to the `payload` column. */
  readonly payload: Record<string, unknown>
  /** Top-level key NAMES that were dropped. Names, never values — see the metric in `ingest.ts`. */
  readonly dropped: readonly string[]
}

/**
 * Apply the allowlist.
 *
 * `declared === null` means the quarantine path: there is no declaration, so nothing is dropped by
 * name and everything is reduced to its shape instead. `dropped` is empty on that path by
 * construction, and that is not an oversight — an unknown topic has no key this build can call
 * unexpected, and reporting all of them as dropped would make the metric useless exactly where the
 * signal matters.
 */
export function redactPayload(payload: unknown, declared: readonly string[] | null): Redaction {
  // A payload that is not an object is wrapped, as `ingest.ts` has always wrapped it, so the column
  // stays a jsonb object. The wrapped value is prose until proven otherwise, so it takes the
  // quarantine rule whatever the topic is: no declaration can name a key that does not exist.
  if (!isPlainObject(payload)) {
    return { payload: { value: shapeOf(payload, 1) }, dropped: [] }
  }

  if (declared === null) {
    return { payload: shapeOf(payload, 0) as Record<string, unknown>, dropped: [] }
  }

  const allowed = new Set(declared)
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const key of Object.keys(payload)) {
    if (allowed.has(key)) out[key] = boundDeclared(payload[key])
    else dropped.push(key)
  }

  // The marker is what makes a producer's new field VISIBLE rather than merely absent. A key name
  // is schema, not personal data, and an operator querying which topics are dropping which keys is
  // how "a producer started sending an address" becomes something somebody notices.
  if (dropped.length > 0) {
    out[REDACTED_MARKER] =
      dropped.length > MAX_REPORTED_KEYS
        ? [...dropped.slice(0, MAX_REPORTED_KEYS).sort(), `<keys:${dropped.length}>`]
        : [...dropped].sort()
  }
  return { payload: out, dropped }
}
