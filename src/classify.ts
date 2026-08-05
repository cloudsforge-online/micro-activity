/**
 * Turning an event into a feed entry.
 *
 * AD-11: activity subscribes to **every** domain topic and keeps the narrative. The table below
 * is that word "every" made checkable — it is declared as
 * `satisfies Readonly<Record<TopicName, TopicClassifier>>`, so a topic added to
 * `@cloudsforge/contracts-events` and not classified here **fails to compile**. That is the
 * property worth having: the alternative is a topic that quietly lands in `unclassified` for six
 * months because nobody remembered this file existed.
 *
 * ## What a classifier may and may not do
 *
 * It may read the envelope. It may not read the database, call another service, or fail. A
 * classifier that threw would turn a delivered event into a 500 and a redelivery loop, and the
 * producer would keep retrying an event that will never be accepted. Every field below therefore
 * has a fallback, and every string taken from a payload is length-capped before it reaches a
 * summary — a summary is rendered in a user's feed and an uncapped one is a stored-XSS surface
 * with a nice name.
 *
 * ## Why `subject_urn` rather than a foreign key
 *
 * 04-domain-model §11: no cross-service foreign keys. The owning service owns the record; this
 * one holds a reference by URN and resolves it by asking, if it ever needs to. A feed that joined
 * to another service's table would be a feed that cannot be read while that service is down.
 */

import {
  TOPICS,
  parseActor,
  parseTopicName,
  type EventEnvelope,
  type ProducerService,
  type TopicName,
} from '@cloudsforge/contracts-events'
import { UNCLASSIFIED, type Category, type StoredCategory, type Visibility } from './categories.ts'
import { redactPayload } from './redact.ts'

/** What a record is, before it has an id and a row. */
export interface Classified {
  readonly category: StoredCategory
  /** `<category>.<verb>` — the narrower name inside a category. Stable, and safe to switch on. */
  readonly type: string
  /** Null when the event has no owner: a reconciliation run, a chain-level fault. */
  readonly userId: string | null
  readonly subjectUrn: string
  readonly summary: string
  readonly amount: string | null
  readonly assetCode: string | null
  readonly visibility: Visibility
  /**
   * The payload AS IT WILL BE STORED — already through the allowlist, never the producer's own.
   *
   * It is returned from here rather than read off the envelope by `ingest.ts` deliberately. The
   * defect being closed is that a caller could write `envelope.payload` straight into the column;
   * leaving the redaction to the caller would leave that exact shape available to the next one. A
   * classifier is the only thing that knows what the topic declared, so the redacted payload is
   * part of what classifying an event produces.
   */
  readonly payload: Record<string, unknown>
  /** Top-level key names the allowlist refused. Names only — `ingest.ts` counts them. */
  readonly redactedKeys: readonly string[]
}

interface TopicClassifier {
  readonly category: Category
  /**
   * `<category>.<verb>`, or a function of the envelope when one topic carries two facts.
   *
   * A function is the exception and needs a reason. `identity.session.revoked` is the reason: it
   * carries a `reason` field that separates "you pressed sign out" from "your session was burned
   * because a stolen refresh token was replayed", and `type` is the field a frontend switches on
   * to choose an icon and an emphasis. One static type for both would render an account takeover
   * with the same chrome as a sign-out. `notify` already refuses to treat them alike — a critical
   * notification fires for every reason except `signed_out` (notify/src/catalogue.ts:258) — and a
   * timeline that collapses the distinction disagrees with the notification the user just got.
   */
  readonly type: string | ((envelope: EventEnvelope) => string)
  readonly visibility: Visibility
  readonly userId: (envelope: EventEnvelope) => string | null
  readonly summary: (envelope: EventEnvelope) => string
  /**
   * **THE PAYLOAD ALLOWLIST. Every key this classifier reads, and nothing else.**
   *
   * A key of the producer's payload that is not named here is never written to
   * `activity_records.payload` — dropped at ingest, not stored and tidied up later. See the header
   * of `redact.ts` for the policy and for the live example that arrived while it was being written
   * (`identity.email.verification_requested` carries an email address and a single-use credential,
   * and this service needs neither).
   *
   * **Required, and that is the point.** The table below is
   * `satisfies Readonly<Record<TopicName, TopicClassifier>>`, so a topic added without a
   * declaration fails `pnpm typecheck` rather than defaulting to "store everything" — the same
   * mechanism that already refuses a topic with no classifier at all.
   *
   * Declare what is READ, not what is sent. `THE RULE: a classifier may not read a payload key it
   * has not declared` drives every entry against a recording Proxy and fails in both directions: a
   * key read and not declared, and a key declared and never read. Over-declaring is not harmless —
   * a second party's identifier left in a payload is one the erasure of that party cannot reach.
   */
  readonly payloadKeys: readonly string[]
}

/* ------------------------------------------------------------------ payload readers */

function payloadOf(envelope: EventEnvelope): Record<string, unknown> {
  const payload = envelope.payload
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/**
 * A string field, capped.
 *
 * The cap is not cosmetic. A summary goes into a user's feed, and a field a producer took from
 * user input — a token name, a listing title — arrives here unbounded. Truncating at the point of
 * use rather than trusting the producer is the only version of this that survives a producer
 * changing its mind about validation.
 */
function text(envelope: EventEnvelope, field: string, max = 64): string | null {
  const value = payloadOf(envelope)[field]
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** A decimal amount. Kept as a string throughout: a feed that rounded a balance would be a lie. */
function amount(envelope: EventEnvelope, field = 'amount'): string | null {
  const value = payloadOf(envelope)[field]
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return value
  return null
}

function asset(envelope: EventEnvelope, field = 'assetCode'): string | null {
  const value = payloadOf(envelope)[field]
  return typeof value === 'string' && /^[A-Z][A-Z0-9:_-]{0,31}$/.test(value) ? value : null
}

/** EMBER's wei exponent — the same 18 `contracts-money` uses. */
const WEI_PER_EMBER = 10n ** 18n

/**
 * A wei quantity, as EMBER, for a SUMMARY LINE ONLY.
 *
 * Never for the `amount` column: `classify` fills that from a payload field named `amount` or
 * `price`, and a topic that pays in wei has neither. Writing wei there would put a number
 * eighteen orders of magnitude out beside an asset code in a user's feed.
 *
 * `/^\d+$/` BEFORE `BigInt`, and that guard is the point rather than tidiness: `BigInt('')` is
 * `0n` and `BigInt(' 7 ')` is `7n`, so an empty or padded string would render as a real payment
 * of nothing. Anything that is not exactly a run of digits is null — "not stated" — and the
 * caller omits the clause rather than printing a zero it did not measure.
 *
 * Trailing zeros are trimmed so a whole number of EMBER reads as `5` and not `5.000000000000000000`;
 * a fractional one keeps every digit it has, because rounding money in a feed is how a feed
 * becomes a thing people stop believing.
 */
function emberFromWei(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const wei = BigInt(value)
  const whole = wei / WEI_PER_EMBER
  const fraction = (wei % WEI_PER_EMBER).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The key is the user id, for the topics whose `keyedBy` in the registry says so. */
function userFromKey(envelope: EventEnvelope): string | null {
  return UUID_PATTERN.test(envelope.key) ? envelope.key : null
}

/** The payload names the user, for topics keyed by something else. */
function userFromPayload(envelope: EventEnvelope): string | null {
  const value = payloadOf(envelope)['userId']
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

/**
 * The ENVELOPE ACTOR names the user, for topics whose payload names nobody at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS READER IS DANGEROUS AND IS ONLY EVER CORRECT WITH THE EMIT SITE IN FRONT OF YOU.**
 *
 * The actor is *who performed the act*, and the feed record belongs to *whose news it is*. Those
 * coincide often enough to be tempting and diverge exactly where it costs the most:
 * `aetherholm.battle.resolved` has the ATTACKER as its actor while the record is the DEFENDER's
 * (see that entry), and `market.listing.sold`'s offer event had the OFFERER as its actor, which is
 * why `notify` refuses the generic helper there and reads `sellerSubject` explicitly. Reaching for
 * this reader because a payload is thin is how "your city was raided" lands in the raider's feed.
 *
 * It is used by exactly three topics — `trade.bot.paused`, `devplatform.key.issued` and
 * `devplatform.key.revoked` — and each one cites the line of its producer that proves the actor is
 * the subject of the news rather than merely its cause. Nothing else may use it without doing the
 * same.
 *
 * `parseActor` from contracts-events rather than a `startsWith('user:')`, because the actor
 * vocabulary is the contract's and this file must not hold a second opinion about it. That is not
 * hypothetical: `devplatform` shipped `key:<display>` and `system:identity`, two spellings the
 * contract has never admitted (`ActorKind` is `user | service | operator | system`, and `system`
 * takes no subject), and a local prefix test would have read both as "not a user" for the right
 * answer by luck rather than refused them as illegal.
 *
 * The UUID check on top is not redundant. `parseActor` accepts any non-empty subject, so
 * `user:alice` parses; a non-uuid subject reaching `activity_records.user_id` is a value no feed
 * query can ever match, which is the silent-misfile failure this file exists to avoid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function userFromActor(envelope: EventEnvelope): string | null {
  const parsed = parseActor(envelope.actor)
  if (!parsed.ok || parsed.value.kind !== 'user') return null
  const id = parsed.value.id
  return id !== null && UUID_PATTERN.test(id) ? id : null
}

/**
 * `user:<uuid>` → `<uuid>`. Anything else — an `org:` subject, a bare id, a malformed value —
 * is null rather than a guess.
 */
function subjectUser(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('user:')) return null
  const id = value.slice('user:'.length)
  return UUID_PATTERN.test(id) ? id : null
}

/**
 * The key is a `user:<id>` subject, as `billing.entitlement.granted` uses.
 *
 * An entitlement's subject can also be an organisation, in which case there is no single user and
 * the record is internal until organisation feeds exist. Guessing an owner would put another
 * member's purchase in someone's personal feed.
 */
function userFromSubjectKey(envelope: EventEnvelope): string | null {
  return subjectUser(envelope.key)
}

/**
 * A PAYLOAD field holding a `user:<id>` subject rather than a bare uuid.
 *
 * `community.vote.cast` is why this exists and it is a trap worth naming: the payload's owner
 * field is called `voter`, not `userId`, and it holds `user:<uuid>` because community's whole
 * membership model is subject-keyed (`community/src/server.ts:875` passes `caller.subject`). So
 * `userFromPayload` finds nothing, and a reader that expected a bare uuid under `voter` would
 * also find nothing — a vote receipt in nobody's feed, which is the one thing the topic exists
 * to deliver.
 */
function userFromSubjectField(field: string): (envelope: EventEnvelope) => string | null {
  return (envelope) => subjectUser(payloadOf(envelope)[field])
}

/**
 * How a session ended, as the user should read it.
 *
 * The four keys are every value identity actually passes — `identity/src/server.ts:993` (password
 * changed), `:1065` (password reset), `:1128` (signed out everywhere) and `:1137`/
 * `sessions.ts:389` (signed out). The fifth case has no constant: `server.ts:892` burns a refresh
 * family when a stolen token is replayed, and whatever reason it carries must fall through to the
 * alarming sentence rather than to a reassuring one.
 *
 * **The fallback is deliberately the alarming one.** `notify` fires a critical notification for
 * every reason except `signed_out`, including one it has never seen, on the grounds that an
 * unrecognised reason is exactly when a user should look. The timeline says the same thing, or a
 * user gets a critical alert and finds a feed entry that reads as routine.
 */
const REVOCATION_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
  signed_out: 'You signed out.',
  signed_out_everywhere: 'You signed out everywhere, and this session ended.',
  password_changed: 'Your password was changed, so this session was signed out.',
  password_reset: 'Your password was reset, so this session was signed out.',
})

const UNKNOWN_REVOCATION =
  'This session was ended for security. If that was not you, change your password now.'

function revocationReason(envelope: EventEnvelope): string {
  const value = payloadOf(envelope)['reason']
  return typeof value === 'string' ? value : ''
}

/**
 * Whether a failed withdrawal's money is coming back.
 *
 * `=== true` and not a truthiness test, and not a default of `true`, because this reader must
 * agree with the consumer that actually moves the money: `wallet/src/server.ts:873` writes
 * `refundable: payload['refundable'] === true` for the stated reason that refunding a payment
 * which really landed pays the user twice. A timeline that said "the money is on its way back"
 * where wallet held the funds and paged an operator would be a feed entry contradicting the
 * balance the user is looking at on the same screen.
 */
function isRefundable(envelope: EventEnvelope): boolean {
  return payloadOf(envelope)['refundable'] === true
}

/* ------------------------------------------------------------------ the table */

/**
 * Every registered topic, classified.
 *
 * `satisfies Readonly<Record<TopicName, TopicClassifier>>` is the enforcement: adding a topic to
 * contracts-events without adding a row here is a compile error in this repository.
 */
export const CLASSIFIERS = Object.freeze({
  'identity.user.registered': {
    payloadKeys: [],
    category: 'account',
    type: 'account.registered',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'Your account was created.',
  },
  /**
   * **THE TOPIC THAT PROVED THE ALLOWLIST WAS NEEDED, ON THE DAY IT WAS BEING WRITTEN.**
   *
   * Registered in `contracts-events` while this file was open. Its payload is
   * `{ userId, handle, email, expiresAt, linkable, verifyUrl? }`
   * (`identity/src/emailVerification.ts:172-185`) and two of those fields are ones this table must
   * never hold: `email` is a direct identifier, and `verifyUrl` is a **live single-use credential**.
   * Identity's own header accepts putting the link on the bus because `notify` has to send it and
   * prunes what it stores; activity subscribes to every topic under AD-11, needs neither field for
   * anything, and until `redact.ts` existed would have stored both verbatim, for ever, in a row
   * nothing deleted. `payloadKeys` is `['linkable']` and that is the entire difference.
   *
   * `account`, not `security`. This is the account not yet being finished — `notify` renders it as
   * `account.verify_email` (`notify/src/catalogue.ts:659`) — and a user reading their timeline for
   * "what happened to my account" should find it beside the registration it belongs to.
   *
   * The summary never names the address and never carries the link. `linkable` is the field that
   * decides the sentence, and it is always present by the producer's design (`emailVerification.ts`
   * :180-183: "a consumer branches on a field that is always there"), so a deployment with no
   * `IDENTITY_ACCOUNT_URL` reads as the different fact it is rather than as a silent nothing.
   */
  'identity.email.verification_requested': {
    payloadKeys: ['linkable'],
    category: 'account',
    type: 'account.email_verification_requested',
    visibility: 'user',
    // Keyed by user_id, as the registry says and as the emit does (`emailVerification.ts:171`).
    userId: userFromKey,
    summary: (event) =>
      payloadOf(event)['linkable'] === true
        ? 'We sent a link to verify your email address. It can be used once and expires in 24 hours.'
        : 'Your email address was asked to be verified, but no link could be built for it.',
  },
  'identity.user.deleted': {
    payloadKeys: [],
    category: 'account',
    type: 'account.deleted',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'Your account was deleted and your data erased.',
  },
  'identity.session.created': {
    payloadKeys: ['userId', 'device', 'ipPrefix'],
    category: 'security',
    type: 'security.session_created',
    visibility: 'user',
    // userFromPayload, NOT userFromKey: identity keys this event by SESSION id
    // (`identity/src/sessions.ts:199`) and names the user in the payload. The key IS a uuid, so
    // userFromKey happily returned the session id as the "user" and every sign-in landed in
    // nobody's feed — silently, because a wrong uuid queries as cleanly as a right one. Found by
    // composing identity next to this service, not by either suite.
    userId: userFromPayload,
    summary: (event) => {
      const device = text(event, 'device', 48)
      const ip = text(event, 'ipPrefix', 24)
      // The truncated prefix, never a full address. 04-domain-model §10.2 stores `ip_prefix` for
      // the same reason: it is enough to recognise "not me" and not enough to locate anybody.
      return device ? `Signed in on ${device}${ip ? ` from ${ip}` : ''}.` : 'Signed in.'
    },
  },
  /**
   * The other half of `identity.session.created`, and the one topic here that is two facts.
   *
   * A plain sign-out and a security revocation are not the same event to somebody reading their
   * own timeline, so they do not get the same `type` — see the note on `TopicClassifier.type`.
   * The category is `security` for both, and that is deliberate rather than lazy: sign-IN is
   * already `security`, so filing sign-OUT anywhere else would mean the two halves of one session
   * cannot be read together under one filter, and a user looking for "what happened to my
   * sessions" would find only half of it.
   */
  'identity.session.revoked': {
    payloadKeys: ['userId', 'reason'],
    category: 'security',
    type: (event) =>
      revocationReason(event) === 'signed_out' ? 'security.signed_out' : 'security.session_revoked',
    visibility: 'user',
    // userFromPayload, NOT userFromKey. The registry keys this by SESSION id
    // (contracts/packages/events/src/index.ts:267, identity/src/sessions.ts:394) and a session id
    // IS a uuid, so userFromKey would return it as the "user" and every revocation would land in
    // nobody's feed — silently, exactly as identity.session.created did. The payload names the
    // user (`identity/src/sessions.ts:397`).
    userId: userFromPayload,
    summary: (event) => REVOCATION_SUMMARIES[revocationReason(event)] ?? UNKNOWN_REVOCATION,
  },
  'identity.device.added': {
    payloadKeys: ['userId', 'device'],
    category: 'security',
    type: 'security.device_added',
    visibility: 'user',
    // Same repair as session.created: identity keys this by DEVICE id (`identity/src/sessions.ts:184`)
    // and names the user in the payload.
    userId: userFromPayload,
    summary: (event) => {
      const device = text(event, 'device', 48)
      return device ? `A new device was used for the first time: ${device}.` : 'A new device was used for the first time.'
    },
  },
  'identity.mfa.removed': {
    payloadKeys: ['wasLast'],
    category: 'security',
    type: 'security.mfa_removed',
    visibility: 'user',
    userId: userFromKey,
    summary: (event) =>
      payloadOf(event)['wasLast'] === true
        ? 'Your last two-factor method was removed. Your account is no longer protected by a second factor.'
        : 'A two-factor method was removed.',
  },
  /**
   * The mirror of `identity.mfa.removed`, and it is the one an attacker triggers.
   *
   * `removed` is news because it can leave an account on its password alone; `added` is news for
   * the opposite reason — a factor an attacker enrols is how they keep an account after the owner
   * resets the password. Same category, same visibility, and `replacedPrevious` is the field that
   * decides which sentence is true, because re-enrolling an authenticator on a new phone and
   * adding a second one are different things to the person reading it.
   */
  'identity.mfa.added': {
    payloadKeys: ['kind', 'replacedPrevious'],
    category: 'security',
    type: 'security.mfa_added',
    visibility: 'user',
    // Keyed by user_id, as the registry says and as the emit does (`identity/src/mfa.ts:566`).
    // The same reader `identity.mfa.removed` uses.
    userId: userFromKey,
    summary: (event) => {
      const kind = text(event, 'kind', 32)
      const named = kind ? ` (${kind})` : ''
      return payloadOf(event)['replacedPrevious'] === true
        ? `A two-factor method${named} was replaced with a new one.`
        : `A two-factor method${named} was added to your account.`
    },
  },
  'ledger.entry.posted': {
    payloadKeys: ['userId', 'amount', 'assetCode', 'kind'],
    // A journal entry is a movement of value. `transfer` is the honest category: the entry itself
    // does not know whether it was a purchase, a reward or a conversion — the service that caused
    // it does, and when those services publish their own topics those entries get filed better.
    category: 'transfer',
    type: 'transfer.entry_posted',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = amount(event)
      const code = asset(event)
      const kind = text(event, 'kind', 32)
      return value && code
        ? `${value} ${code} moved${kind ? ` (${kind})` : ''}.`
        : 'A ledger entry was posted against your account.'
    },
  },
  /**
   * **DEAD CODE TODAY: nobody emits this.** Checked while adding settlement's three, because a
   * classifier for a topic no producer sends is the same defect as a producer no classifier
   * covers, and only the first has a compile error to announce it.
   *
   * `micro-org`'s estate-wide check is the authority (`org/tools/estate-topic-gaps.json`,
   * `unemitted:ledger.reconciliation.completed`) and this repository re-verified it rather than
   * copying it: the string appears nowhere in `ledger/src`, and ledger's only emit is
   * `ledger.entry.posted` (`ledger/src/entries.ts:427`). A reconciliation that finishes announces
   * it to nobody, so the operator query "did last night's run complete" reads a topic that has
   * never carried a message. Owner: micro-ledger. The classifier stays — it is correct, and it is
   * what makes the emit land in the right place on the day it is written.
   */
  'ledger.reconciliation.completed': {
    payloadKeys: ['drift'],
    category: 'wallet',
    type: 'wallet.reconciliation_completed',
    // Nobody's feed. It has no user and it is an operational fact, but it is still a domain event
    // worth a permanent, queryable record — and this is the service that keeps those.
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const drift = amount(event, 'drift')
      return drift ? `Reconciliation completed with drift ${drift}.` : 'Reconciliation completed.'
    },
  },
  /**
   * `wallet`, not `account` and not `ownership`.
   *
   * The sixteen have a `wallet` category and this is the first topic that puts a user-visible
   * record in it — until now only `ledger.reconciliation.completed` filed there, and that one is
   * internal, so the filter existed with nothing behind it. A wallet being registered is the
   * canonical `wallet` fact.
   *
   * `origin` decides the sentence. A custodial wallet is something the platform made for you; an
   * external one is a wallet you already had and linked. Reading them as the same event would
   * hide the case that actually matters — a link the user did not make.
   */
  'wallet.wallet.created': {
    payloadKeys: ['userId', 'chain', 'network', 'origin'],
    category: 'wallet',
    type: 'wallet.created',
    visibility: 'user',
    // Keyed by WALLET id (`wallet/src/wallets.ts:216`, registry keyedBy `wallet_id`); the payload
    // names the user (`wallet/src/wallets.ts:219`).
    userId: userFromPayload,
    summary: (event) => {
      const chain = text(event, 'chain', 24)
      const network = text(event, 'network', 24)
      const where = chain ? ` on ${chain}${network ? ` ${network}` : ''}` : ''
      return payloadOf(event)['origin'] === 'external'
        ? `An external wallet was linked to your account${where}.`
        : `A wallet was created for you${where}.`
    },
  },
  'wallet.deposit.confirmed': {
    payloadKeys: ['userId', 'amount', 'assetCode'],
    category: 'deposit',
    type: 'deposit.confirmed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = amount(event)
      const code = asset(event)
      return value && code ? `Deposit of ${value} ${code} confirmed and credited.` : 'A deposit was confirmed.'
    },
  },
  'wallet.withdrawal.requested': {
    payloadKeys: ['userId', 'amount', 'assetCode'],
    category: 'withdrawal',
    type: 'withdrawal.requested',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = amount(event)
      const code = asset(event)
      return value && code ? `Withdrawal of ${value} ${code} requested.` : 'A withdrawal was requested.'
    },
  },
  'settlement.withdrawal.completed': {
    payloadKeys: ['userId', 'amount', 'assetCode', 'transactionHash'],
    category: 'withdrawal',
    type: 'withdrawal.completed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = amount(event)
      const code = asset(event)
      const hash = text(event, 'transactionHash', 66)
      const money = value && code ? `${value} ${code}` : 'Your withdrawal'
      return `${money} was sent${hash ? ` in ${hash}` : ''}.`
    },
  },
  'settlement.withdrawal.stuck': {
    payloadKeys: ['userId'],
    category: 'withdrawal',
    type: 'withdrawal.stuck',
    // Keyed by `chain:network`, so there may be no user on it. When the payload names one the
    // record is theirs; otherwise it is an operational record that pages somebody.
    visibility: 'user',
    userId: userFromPayload,
    summary: () => 'A withdrawal has not confirmed within its deadline and is being investigated.',
  },
  /* ── settlement's three newly registered topics, and why only ONE of them names a user ───────
   *
   * All three are keyed by something that is not a user, and all three would have been misfiled by
   * the obvious reader. A withdrawal id is a `uuid` (`wallet/src/migrations.ts:364-365`) and a
   * sweep source id is a `uuid` too, so `userFromKey` does not return null on any of them — it
   * returns a real, well-formed, wrong id, and a wrong uuid queries exactly as cleanly as a right
   * one. That is `identity.session.created` twice over, which is the one mistake this file has
   * already made in production.
   *
   * `userFromPayload` is not automatically the repair either. `confirmedEvents`
   * (`settlement/src/withdrawals.ts:436-448`) and `failedEvents` (`:475-486`) build DELIBERATELY
   * NARROW payloads — `{ withdrawalId, txHash, confirmedAt }` and
   * `{ withdrawalId, reason, refundable }` — and neither carries `userId`. So for these two the
   * honest answer today is "no user is available", and the interesting question is what each of
   * them should do about it. They answer differently, and the difference is the whole point.
   * ------------------------------------------------------------------------------------------ */
  /**
   * **Nobody's feed, on purpose — because the user already has this entry.**
   *
   * This is not a case of "no user could be found and so we gave up". `confirmedEvents`
   * (`settlement/src/withdrawals.ts:436-462`) returns BOTH `settlement.outbound.confirmed` and
   * `settlement.withdrawal.completed` from a single `return [...]`, behind a single guard
   * (`row.purpose !== 'withdrawal' || !row.sourceRef`), for the same row. They are not two facts
   * that usually coincide; they are one fact emitted twice by one statement, and neither can occur
   * without the other. `settlement.withdrawal.completed` is classified sixteen lines above as
   * `withdrawal.completed`, `user`-visible, owner read off its payload's `userId` — which that
   * payload does carry (`withdrawals.ts:456`).
   *
   * Activity subscribes to every topic (AD-11), so it receives both. Attributing this one to a
   * user would therefore put "your withdrawal was sent" in that user's timeline TWICE for one
   * payment — which reads to the person holding the phone as two withdrawals, and is a worse feed
   * than a missing entry because it is a plausible one. wallet's subscription is the reason the
   * narrow topic exists at all (`wallet/src/settlement.ts:167`, branched on at
   * `wallet/src/server.ts:859` to release the reservation); the feed is not its audience.
   *
   * `() => null` rather than `userFromPayload`, and that choice is load-bearing rather than
   * decorative. `userFromPayload` returns null today too, so both spellings behave identically —
   * but the day settlement widens this payload (an entirely reasonable thing for it to do; the row
   * has `userId` right there at `outbound.ts:230`), `userFromPayload` would SILENTLY start
   * double-posting every completed withdrawal into a real feed, with no diff in this repository to
   * blame. A refusal has to be spelled as a refusal or it is only a coincidence.
   */
  'settlement.outbound.confirmed': {
    payloadKeys: [],
    category: 'withdrawal',
    type: 'withdrawal.outbound_confirmed',
    // Internal, and `classify` would force it there anyway once `userId` is null. Both are stated:
    // the declared visibility says what this record IS, the guard says what it can never become.
    visibility: 'internal',
    userId: () => null,
    summary: () =>
      "A withdrawal's transaction reached its confirmation depth and the reservation held against it was released.",
  },
  /**
   * The only report a failed withdrawal has, and the one that is two facts.
   *
   * **Two facts.** `refundable` decides which of two materially different things happened, and
   * `wallet/src/withdrawals.ts:592-600` is where the difference is real rather than editorial:
   * `refundable === true` transitions the withdrawal to `failed` and then calls `refundWithdrawal`,
   * releasing the reservation back into the user's spendable balance; anything else transitions it
   * to **`stuck`** and returns — the funds stay held while an operator establishes whether the
   * payment left the platform. "Your money is coming back" and "your money is still held and
   * somebody is looking into it" are not one entry with a softer adjective. A single static `type`
   * would hand the frontend one icon for both, and `TopicClassifier.type` is a function precisely
   * so that `identity.session.revoked` would not have to do that.
   *
   * **The user, and the gap.** This topic carries no `userId` — `failedEvents`
   * (`settlement/src/withdrawals.ts:475-486`) emits `{ withdrawalId, reason, refundable }` and
   * nothing else — so `userFromPayload` finds nothing and `classify` files the record as internal.
   * That is stated rather than papered over, because unlike `.confirmed` above there is no second
   * topic covering this fact for the user: `failedEvents` returns a one-element array, no
   * `settlement.withdrawal.failed` exists in the registry, and the only other event in the
   * sequence is `wallet.withdrawal.refunded` (`wallet/src/withdrawals.ts:640`), which is
   * unregistered, fires only on the refundable branch, and so cannot cover the stuck one at all.
   * **A failed withdrawal is currently in nobody's timeline.** A classifier may not read a
   * database, so this repository cannot close that; the repair is one field on settlement's
   * payload — `userId: row.userId`, which `stuckEvents` already puts on the neighbouring event
   * (`withdrawals.ts:521`) from the same row — and it is filed for micro-settlement.
   *
   * `userFromPayload` rather than `() => null` is the opposite call from `.confirmed`, for the
   * opposite reason: there the payload widening would introduce a duplicate, here it would deliver
   * the entry that is missing. The moment settlement adds the field this record reaches its owner
   * with no change in this file, and the test below pins BOTH states so neither can drift silently.
   */
  'settlement.outbound.failed': {
    payloadKeys: ['userId', 'refundable'],
    category: 'withdrawal',
    type: (event) =>
      isRefundable(event) ? 'withdrawal.failed_refunded' : 'withdrawal.failed_held',
    visibility: 'user',
    // NOT userFromKey: the key is the WITHDRAWAL id (`withdrawals.ts:480`, registry keyedBy
    // `withdrawal_id`) and it is a uuid (`wallet/src/migrations.ts:364-365`), so userFromKey would
    // hand back a withdrawal id as a user id — well-formed, queryable and wrong.
    userId: userFromPayload,
    summary: (event) =>
      isRefundable(event)
        ? 'Your withdrawal could not be sent, and the amount is being returned to your balance.'
        : 'Your withdrawal could not be completed. The amount is still held while we confirm whether the payment left the platform.',
  },
  /**
   * A sweep is an INTERNAL custody movement, and this is the judgement call in the three.
   *
   * A sweep empties a user's per-address deposit balance into the pinned treasury address
   * (`settlement/src/sweeps.ts`). The case for showing it to the user is real and worth stating
   * before refusing it: this is the one event in the estate that says customer funds crossed into
   * the blast radius of the signing credential, and "money of mine moved somewhere I did not ask
   * it to move" sounds exactly like something a person is entitled to read.
   *
   * It is refused on three grounds, in increasing order of how much they matter.
   *
   * 1. There is no user on the event. The payload (`sweeps.ts:494-507`) is
   *    `{ outboundId, sweepSourceId, chain, network, assetCode, from, to, amount, fee, txHash,
   *    confirmedAt }`. The owner exists but only in a table: `sweep_sources.custody_user_id`,
   *    which settlement itself has to go and read (`sweepBindingFor`, `sweeps.ts:455-468`). A
   *    classifier may not read a database — see the header — so a user-visible answer here would
   *    have to be invented, and `classify` would demote it to internal regardless.
   * 2. **Nothing about the user's position changes.** The user's claim on the platform was
   *    credited at `wallet.deposit.confirmed`, which is already in their feed as
   *    `deposit.confirmed`. A sweep moves platform-controlled funds between two
   *    platform-controlled addresses; the balance, the entitlement and the ledger position are all
   *    exactly what they were a moment before. A timeline entry whose true content is "no change
   *    occurred" is not a disclosure, it is an alarm the reader can do nothing with — and one
   *    phrased in terms of an address they never chose and a treasury they have no relationship
   *    with.
   * 3. It is somebody's news, just not the account holder's. Where a sweep genuinely matters is
   *    reconciliation: `ledger.reconciliation.completed` compares totals with nothing telling it
   *    which movements produced them, and this is that missing input. So it files under `wallet`
   *    and `internal` — the same home as `wallet.reconciliation_completed` — because the two
   *    records an operator has to read together should sit under one filter. That is the argument
   *    that put sign-IN and sign-OUT both under `security`, applied to treasury accounting.
   *
   * The summary deliberately carries no amount. `row.amount` is smallest units
   * (`settlement/src/withdrawals.ts:123`, `chains.ts:432`), the payload does not say how many
   * decimals the asset has, and a rendered figure that is off by eighteen orders of magnitude is
   * worse for the operator reading it than no figure at all. `assetCode` and `amount` still reach
   * the record's own columns through `classify`, where they are typed and not prose.
   */
  'settlement.sweep.completed': {
    payloadKeys: ['chain', 'network', 'amount', 'assetCode'],
    category: 'wallet',
    type: 'wallet.sweep_completed',
    visibility: 'internal',
    // The key is the SWEEP SOURCE id, a uuid — so userFromKey returns a deposit-address row id as
    // a "user". The payload names no user either, and the one that exists is behind a query.
    userId: () => null,
    summary: (event) => {
      const chain = text(event, 'chain', 24)
      const network = text(event, 'network', 24)
      const where = chain ? ` on ${chain}${network ? ` ${network}` : ''}` : ''
      return `A deposit address was swept into the treasury${where}.`
    },
  },
  /* ── aetherholm — the third Worlds title, and the first game in the registry ────────────────
   *
   * The sixteen categories predate any game: 01-product-vision promises "every account, money,
   * asset, GAME and governance event on one timeline", and there is no `game` category to put one
   * in. These five map to the nearest honest homes — founding and provisioning are `ownership`,
   * completions are `reward`, a season opening is `community` and internal. Adding the missing
   * category is a schema CHECK change and is recorded as a gap rather than smuggled in here.
   */
  /* ── worlds and emberkin — ten topics a live producer emitted before the registry knew them ──
   * Same keying discipline as the aetherholm five: every userId reader cites the emit line,
   * because `session.created` keyed-by-session meeting userFromKey is how sign-ins landed in
   * nobody's feed. The game-category gap stands: these file under the nearest of the sixteen.
   */
  'worlds.title.registered': {
    payloadKeys: ['name'],
    category: 'community',
    type: 'worlds.title_registered',
    // An operator act on the platform, no player subject (`worlds/src/titles.ts:169-176`).
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const name = text(event, 'name', 48)
      return name ? `Title registered: ${name}.` : 'A title was registered.'
    },
  },
  'worlds.reward.granted': {
    payloadKeys: ['userId', 'amountShards'],
    category: 'reward',
    type: 'worlds.reward_granted',
    visibility: 'user',
    // Keyed by REWARD id; the user is in the payload (`worlds/src/rewards.ts:470`).
    userId: userFromPayload,
    summary: (event) => {
      const amount = text(event, 'amountShards', 24)
      return amount ? `You earned ${amount} Shards.` : 'You earned a season reward.'
    },
  },
  'worlds.provision.completed': {
    payloadKeys: ['subject'],
    category: 'ownership',
    type: 'worlds.provision_completed',
    visibility: 'user',
    // Keyed by ENTITLEMENT id; the user is the provision `subject`
    // (`worlds/src/provisioning.ts:566-571`), and the actor is the service — the actor fallback
    // would attribute this to nobody.
    userId: (event) => {
      const value = payloadOf(event)['subject']
      return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
    },
    summary: () => 'Your private world is ready.',
  },
  'worlds.provision.failed': {
    payloadKeys: ['subject'],
    category: 'billing',
    type: 'worlds.provision_failed',
    visibility: 'user',
    // Same subject reader (`worlds/src/provisioning.ts:602-613`): the person who paid must see
    // the failure in their own feed, since the refund names the entitlement this row carries.
    userId: (event) => {
      const value = payloadOf(event)['subject']
      return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
    },
    summary: () => 'A world purchase could not be delivered and is being looked at.',
  },
  'emberkin.achievement.unlocked': {
    payloadKeys: ['userId', 'name'],
    category: 'reward',
    type: 'emberkin.achievement_unlocked',
    visibility: 'user',
    // Keyed `user:code`, NOT a bare uuid (`emberkin/src/battles.ts:204-205`) — userFromKey would
    // return null; the payload names the user.
    userId: userFromPayload,
    summary: (event) => {
      const name = text(event, 'name', 48)
      return name ? `Achievement unlocked: ${name}.` : 'Achievement unlocked.'
    },
  },
  'emberkin.battle.resolved': {
    payloadKeys: ['userId', 'outcome'],
    category: 'reward',
    type: 'emberkin.battle_resolved',
    visibility: 'user',
    // Keyed by BATTLE id; user in the payload (`emberkin/src/battles.ts:215`).
    userId: userFromPayload,
    summary: (event) => {
      const outcome = text(event, 'outcome', 16)
      return outcome ? `Battle ${outcome}.` : 'A battle resolved.'
    },
  },
  'emberkin.cosmetic.equipped': {
    payloadKeys: ['userId'],
    category: 'ownership',
    type: 'emberkin.cosmetic_equipped',
    visibility: 'user',
    userId: userFromPayload,
    summary: () => 'You equipped a cosmetic.',
  },
  'emberkin.save.started': {
    payloadKeys: ['userId'],
    category: 'account',
    type: 'emberkin.save_started',
    visibility: 'user',
    userId: userFromPayload,
    summary: () => 'You began a new campaign.',
  },
  'emberkin.season.started': {
    payloadKeys: [],
    category: 'community',
    type: 'emberkin.season_started',
    visibility: 'internal',
    userId: () => null,
    summary: () => 'A new Emberkin season opened.',
  },
  'emberkin.reward.granted': {
    payloadKeys: ['userId', 'amount'],
    category: 'reward',
    type: 'emberkin.reward_granted',
    visibility: 'user',
    // Keyed by idempotency key; user in the payload (`emberkin/src/seasons.ts:139`).
    userId: userFromPayload,
    summary: (event) => {
      const amount = text(event, 'amount', 24)
      return amount ? `You earned ${amount} Shards.` : 'You earned a season reward.'
    },
  },
  'aetherholm.season.opened': {
    payloadKeys: ['name'],
    category: 'community',
    type: 'aetherholm.season_opened',
    // A world event, not a person's: keyed by season, no user anywhere in it.
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const name = text(event, 'name', 48)
      return name ? `Season ${name} opened.` : 'A new season opened.'
    },
  },
  'aetherholm.city.founded': {
    payloadKeys: ['userId', 'name'],
    category: 'ownership',
    type: 'aetherholm.city_founded',
    visibility: 'user',
    // Keyed by CITY id; the user is in the payload (aetherholm/src/cities.ts:183). The session
    // misattribution above is why this is spelled out rather than left to userFromKey.
    userId: userFromPayload,
    summary: (event) => {
      const name = text(event, 'name', 48)
      return name ? `You founded ${name}.` : 'You founded a sky-city.'
    },
  },
  'aetherholm.building.completed': {
    payloadKeys: ['userId', 'type'],
    category: 'reward',
    type: 'aetherholm.building_completed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const kind = text(event, 'type', 32)
      return kind ? `Your ${kind} finished building.` : 'A building finished.'
    },
  },
  'aetherholm.research.completed': {
    payloadKeys: ['userId'],
    category: 'reward',
    type: 'aetherholm.research_completed',
    visibility: 'user',
    userId: userFromPayload,
    summary: () => 'Research completed.',
  },
  'aetherholm.skerry.provisioned': {
    payloadKeys: ['subject'],
    category: 'ownership',
    type: 'aetherholm.skerry_provisioned',
    visibility: 'user',
    // Keyed by ENTITLEMENT id; the user is the provision subject
    // (aetherholm/src/provisioning.ts:109).
    userId: (event) => {
      const value = payloadOf(event)['subject']
      return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
    },
    summary: () => 'Your private skerry is ready.',
  },
  'aetherholm.battle.resolved': {
    payloadKeys: ['defenderUserId', 'cityName', 'outcome'],
    // The nearest honest home among the sixteen is ownership: the record is about what happened
    // to YOUR city. Not `reward` — half of these are losses.
    category: 'ownership',
    type: 'aetherholm.battle_resolved',
    visibility: 'user',
    // Keyed by BATTLE id, actor is the ATTACKER (`user:` prefix on the emit,
    // aetherholm/src/fleets.ts:497), and the payload carries attackerUserId AND defenderUserId.
    // The feed record belongs to the DEFENDER — "your city was raided" is their news; the
    // attacker is watching the fleet screen. Reading `userId`/key/actor here would file the raid
    // in the raider's feed, which is the session.created misattribution with a cannon.
    userId: (event) => {
      const value = payloadOf(event)['defenderUserId']
      return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
    },
    summary: (event) => {
      const name = text(event, 'cityName', 48)
      const city = name ? `Your city ${name}` : 'Your city'
      const outcome = payloadOf(event)['outcome']
      if (outcome === 'razed') return `${city} was besieged and razed.`
      if (outcome === 'repelled') return `${city} repelled an attack.`
      return `${city} was raided.`
    },
  },
  'aetherholm.spire.captured': {
    payloadKeys: ['holderUserId', 'allianceName'],
    category: 'reward',
    type: 'aetherholm.spire_captured',
    visibility: 'user',
    // Keyed by ISLAND id. A lone holder is named as holderUserId
    // (aetherholm/src/sealing.ts:243); an alliance holds as a group, in which case there is no
    // single owner and the record stays internal rather than landing in one member's feed —
    // the same refusal as billing's organisation-subject entitlements above.
    userId: (event) => {
      const value = payloadOf(event)['holderUserId']
      return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
    },
    summary: (event) => {
      const alliance = text(event, 'allianceName', 48)
      return alliance
        ? `${alliance} held an Aether Spire as the season sealed.`
        : 'You held an Aether Spire as the season sealed. Heraldry is yours.'
    },
  },
  'aetherholm.season.sealed': {
    payloadKeys: ['name'],
    category: 'community',
    type: 'aetherholm.season_sealed',
    // A world event, like season.opened: keyed by season, no single user is its subject. The
    // victors' personal records come from spire.captured.
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const name = text(event, 'name', 48)
      return name ? `${name} sealed into the chronicle.` : 'A season sealed into the chronicle.'
    },
  },
  'billing.entitlement.granted': {
    payloadKeys: ['scope'],
    category: 'billing',
    type: 'billing.entitlement_granted',
    visibility: 'user',
    userId: userFromSubjectKey,
    summary: (event) => {
      const scope = text(event, 'scope', 64)
      return scope ? `You now have access to ${scope}.` : 'An entitlement was granted.'
    },
  },
  'billing.entitlement.revoked': {
    payloadKeys: ['scope'],
    category: 'billing',
    type: 'billing.entitlement_revoked',
    visibility: 'user',
    userId: userFromSubjectKey,
    summary: (event) => {
      const scope = text(event, 'scope', 64)
      return scope ? `Your access to ${scope} ended.` : 'An entitlement was revoked.'
    },
  },
  'custody.export.requested': {
    payloadKeys: [],
    category: 'security',
    type: 'security.key_export_requested',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'A private key export was requested. It will not complete for 24 hours.',
  },
  'custody.key.exported': {
    payloadKeys: [],
    category: 'security',
    type: 'security.key_exported',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'A private key left the platform. That wallet is now self-custodied.',
  },
  /**
   * **DEAD CODE TODAY: nobody emits this either**, and here the producer is not silent — it is
   * using five other names. `mint/src/tokens.ts:254-258` declares `mint.token.created`, `.paid`,
   * `.broadcast`, `.deployed` and `.failed`; `mint.deploy.confirmed` is not among them, and none
   * of the five is registered. So the one fact the estate agreed to send is the one name mint does
   * not use, while five real events arrive here as `unclassified`. Owner: micro-mint
   * (`org/tools/estate-topic-gaps.json`, `unemitted:mint.deploy.confirmed`), re-verified against
   * `mint/src` rather than taken on trust.
   *
   * The other two entries that check named — `custody.key.exported` and
   * `settlement.withdrawal.stuck` — have since been repaired by their own repositories
   * (`custody/src/exports.ts:459`, `settlement/src/withdrawals.ts:517-547`), so those two
   * classifiers are live. These are the two that are not.
   */
  'mint.deploy.confirmed': {
    payloadKeys: ['userId', 'name', 'contractAddress'],
    category: 'token',
    type: 'token.deploy_confirmed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const name = text(event, 'name', 48)
      const address = text(event, 'contractAddress', 66)
      return `${name ? `${name} is` : 'Your contract is'} live${address ? ` at ${address}` : ''}.`
    },
  },
  'market.listing.sold': {
    payloadKeys: ['userId', 'price', 'assetCode'],
    category: 'market',
    type: 'market.listing_sold',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = amount(event, 'price')
      const code = asset(event)
      return value && code ? `A listing sold for ${value} ${code}.` : 'A listing sold.'
    },
  },
  /**
   * **THE SELLER'S RECORD, AND EVERY OTHER FIELD ON THE ENVELOPE NAMES THE OFFERER.**
   *
   * The actor is the offerer, `offererSubject` is the offerer, and the key is the listing — so the
   * only subject a reader could resolve without thinking is the one person for whom this is not
   * news. `micro-market` put `sellerSubject` on the payload for exactly this reason and wrote the
   * argument beside it (`market/src/bids.ts:453-479`): "a notification sent to the wrong person
   * about someone else's money is worse than no notification". `notify` had declined to write a
   * rule at all while the field was missing. This classifier reads that field and no other.
   *
   * A SUBJECT, not a bare uuid — a listing may be owned by a service principal
   * (`market/src/server.ts:713` takes the seller from `subjectOf(principal)`), and
   * `userFromSubjectField` returns null for `service:<name>` rather than filing a machine's sale
   * in a person's feed. A null owner is made `internal` by `classify` below.
   *
   * `amount` and `assetCode` are picked up generically by `classify`: the payload spells them with
   * those exact names.
   */
  'market.offer.made': {
    payloadKeys: ['sellerSubject', 'amount', 'assetCode'],
    category: 'market',
    type: 'market.offer_made',
    visibility: 'user',
    userId: userFromSubjectField('sellerSubject'),
    summary: (event) => {
      const value = amount(event)
      const code = asset(event)
      return value && code
        ? `Someone offered ${value} ${code} on your listing.`
        : 'Someone made an offer on your listing.'
    },
  },
  'community.proposal.executed': {
    payloadKeys: ['userId', 'title'],
    category: 'governance',
    type: 'governance.proposal_executed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const title = text(event, 'title', 64)
      return title ? `Proposal "${title}" passed its timelock and executed.` : 'A proposal executed.'
    },
  },
  /* ── the two other halves of the governance lifecycle ──────────────────────────────────────
   * Both are `governance` rather than `community`, and that is a decision about what a filter
   * means: `community.proposal.executed` above is already `governance`, so splitting the same
   * proposal's lifecycle across two categories would mean a user filtering `governance` sees the
   * spend but not the vote that authorised it. `notify` files `proposal.opened` under `community`
   * and `vote.cast` under `governance`, which is right THERE — notify's categories are
   * preference switches, and "tell me about my communities" is a different subscription from
   * "tell me about my votes". A timeline is a narrative, and the narrative is one proposal.
   * ------------------------------------------------------------------------------------------ */
  'community.proposal.opened': {
    payloadKeys: ['title'],
    category: 'governance',
    type: 'governance.proposal_opened',
    // NOBODY'S FEED, and this is the one classification here that refuses to name an owner.
    //
    // The emit (`community/src/jobs.ts:220-227`) is a scheduled transition run by
    // `actor: 'service:community'`, and its payload is `{ proposalId, communityId }` — there is no
    // user on it at all, not even the author, because nobody performed the act. Fanning it out to
    // every member is `notify`'s job and notify does it (`membersOf(event, 'open')`); notify has a
    // recipient list, and a classifier here may not read a database, so activity cannot turn one
    // event into N member records. Guessing an owner from `communityId` would file a
    // community-wide fact in one person's feed.
    //
    // Same shape as `aetherholm.season.opened` and `emberkin.season.started`: a world event with
    // no individual subject is internal, and the personal records come from the topics that do
    // have one — `community.vote.cast` below.
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const title = text(event, 'title', 64)
      return title
        ? `Voting opened on "${title}".`
        : 'A proposal left discussion and its voting window is open.'
    },
  },
  'community.vote.cast': {
    payloadKeys: ['voter', 'choice', 'subjectsCounted'],
    category: 'governance',
    type: 'governance.vote_cast',
    visibility: 'user',
    // The receipt, and it must reach the voter or the topic does nothing. Keyed by PROPOSAL id,
    // and the owner field is `voter` holding `user:<uuid>` — see `userFromSubjectField`.
    userId: userFromSubjectField('voter'),
    summary: (event) => {
      const choice = text(event, 'choice', 16)
      const counted = payloadOf(event)['subjectsCounted']
      // `subjectsCounted` is 1 for a vote cast for oneself and more when delegations rode along.
      // Saying so is the difference between a receipt and a reassurance: a delegate who expected
      // to carry nine delegators and sees "1" has found a problem worth reporting.
      const delegated =
        typeof counted === 'number' && counted > 1 ? `, counted for ${counted} members` : ''
      return choice ? `Your vote (${choice}) was recorded${delegated}.` : `Your vote was recorded${delegated}.`
    },
  },
  /* ── trade's one and devplatform's two: three topics whose PAYLOADS NAME NOBODY ─────────────
   *
   * Registered together by micro-contracts `8889373`, and the three that made this file fail to
   * compile. That compile error was the cheap half of the fault. The expensive half is that
   * `classify` dereferences `CLASSIFIERS[topic]` for any topic the registry knows
   * (`classify.ts`, the `known` branch), so an unclassified-but-registered topic is a `TypeError`
   * inside the ingest transaction — a 500, no inbox row, and a relay that redelivers the same
   * event for ever against a service that can never accept it. A missing classifier is not a
   * cosmetic gap; it is a delivery loop.
   *
   * **All three are keyed by a uuid that is not a user** — `bot_id`, `key_id`, `key_id` — so
   * `userFromKey` returns a real, well-formed, wrong id on every one of them — the
   * `identity.session.created` misattribution again, on three more topics. `unit.test.ts`'s
   * key-reader rule covers all three the moment the registry names them, because it is written
   * against the registry's `keyedBy` rather than against a list somebody has to remember to
   * extend.
   *
   * **And all three carry no user in the payload either**, so `userFromPayload` — the repair that
   * worked for settlement's, wallet's and identity's — finds nothing here:
   *
   *   - `trade/src/bots.ts:614`, the sole `trade.bot.paused` emit, sends `{ botId }`.
   *   - `devplatform/src/apikeys.ts:283-296`, `emitKeyIssued`, sends
   *     `{ keyId, projectId, environment, display, scopes }`.
   *   - `devplatform/src/apikeys.ts:368-382`, `emitKeyRevoked`, sends
   *     `{ keyId, projectId, environment, display, lookupId, reason }`.
   *
   * The owner is on the ENVELOPE, in `actor`, and only reading it there gets these three into the
   * right feed. See `userFromActor` for why that reader is quarantined to exactly these topics and
   * what it costs when it is used anywhere else. `notify` reached the same conclusion from the
   * same payloads for its two API-key rules, independently and first.
   * ------------------------------------------------------------------------------------------ */
  /**
   * The first record in the `trading` category — a filter that has existed with nothing behind it.
   *
   * **One fact, not two.** A pause is a pause: `pauseBot` (`trade/src/bots.ts:610-616`) has one
   * caller (`trade/src/server.ts:672`), one guard (`bot.status !== 'running'`) and one payload, and
   * there is no field on the event that separates two different pieces of news. The variation that
   * WOULD matter — an owner pausing versus trade halting a bot that breached a limit — does not
   * exist yet, because nothing but the owner's route calls it.
   *
   * **The summary says the position is still open, and that sentence is the reason the entry is
   * worth writing.** `pauseBot`'s own documentation is explicit that "pause is deliberately not a
   * flatten": the position stays open, and a paused bot is only ever reconciled by the settlement
   * sweep, never assessed, so its equity is a mark from whenever it last ticked against an
   * unrealised position that may be worth anything by now. A feed entry reading "your bot stopped"
   * and nothing more leaves the owner believing they are flat when they are not. `notify` says the
   * same thing for the same reason (`notify/src/catalogue.ts`, the `trade.bot.paused` rule).
   *
   * The bot is not named in the prose. The payload carries only `botId`, a uuid, and a uuid in a
   * sentence is noise a reader cannot act on; the id reaches `subject_urn` as a typed reference
   * instead, which is what a frontend links from.
   */
  'trade.bot.paused': {
    payloadKeys: [],
    category: 'trading',
    type: 'trading.bot_paused',
    visibility: 'user',
    // The actor is the bot's OWNER and not the caller: `bots.ts:614` writes
    // `actor: \`user:${bot.userId}\`` off the row, so it names the owner whoever pressed the
    // button. NOT userFromKey — the key is `bot.id` (registry `keyedBy: 'bot_id'`), a uuid, so a
    // key reader would file every pause against a bot id dressed as a person.
    userId: userFromActor,
    summary: () =>
      'Your trading bot stopped. Pausing does not close its position — that stays open until you resume or stop the bot.',
  },
  /**
   * The first record in the `api` category, and the same empty-filter story as `trading`.
   *
   * **An API key acts as the account, with no password and no second factor**, so a key the owner
   * did not create is what a compromise looks like from the inside. That is why this is a
   * user-visible timeline entry and not an internal one.
   *
   * **One fact.** The tempting split is user-created versus machine-created (a key minting a key
   * authenticates as `service:<display>`), and it is refused because that distinction is already
   * carried by two other fields: such an event has no user, so `userId` is null and `classify`
   * makes the record internal. A `type` function would be a second, weaker spelling of a
   * difference `visibility` already states exactly — and `TopicClassifier.type` is a function only
   * where a field of the payload separates two messages a reader must not confuse.
   *
   * The DISPLAY (`cfk_live_…`) is rendered and the secret never is. devplatform is careful about
   * this at the emit — `emitKeyIssued`'s own note says the event "carries the DISPLAY, never the
   * key" — and the display is the string an operator finds in a log line and quotes at a
   * revocation, so it is the identifier that makes the entry actionable.
   */
  'devplatform.key.issued': {
    payloadKeys: ['display', 'environment'],
    category: 'api',
    type: 'api.key_issued',
    visibility: 'user',
    // `devplatform/src/server.ts:945`, in the key-issuing route, passes `actorOf(caller)` — which
    // is `user:<id>` for a session-holding caller (`actorOf`, `server.ts:701`).
    // In the case this record exists for — a stolen session — that id IS the victim's, because the
    // attacker is acting as them, so the entry lands where it can be recognised as wrong. NOT
    // userFromKey: the key is `key.id` (registry `keyedBy: 'key_id'`), a uuid that is a credential
    // and not a person.
    userId: userFromActor,
    summary: (event) => {
      const display = text(event, 'display', 48)
      const environment = text(event, 'environment', 24)
      const where = environment ? ` in ${environment}` : ''
      return display
        ? `An API key ${display} was created on your project${where}. It can act as you without a password.`
        : `An API key was created on your project${where}. It can act as you without a password.`
    },
  },
  /**
   * **Two facts, and the discriminator is the actor rather than the payload.**
   *
   * A key you revoked and a key the platform revoked out from under you are not one entry with a
   * softer adjective, and the difference is real in the producer rather than editorial. There are
   * two emit paths and they are reached by different events:
   *
   *   - `devplatform/src/server.ts:999`, the key-revocation route — the owner's own `DELETE`,
   *     actor `actorOf(caller)`. The news is a receipt: an integration the reader deliberately
   *     broke.
   *   - `devplatform/src/server.ts:1575`, in the `identity.organisation.deleted` handler, which
   *     suspends the organisation and revokes EVERY live key it holds in one transaction, actor
   *     `service:identity`. The news is that a company's entire production integration stopped, at
   *     whatever hour identity processed the erasure, without anybody there touching anything.
   *
   * A single static `type` hands a frontend one icon for both, which is the mistake
   * `identity.session.revoked` exists in this file to avoid repeating.
   *
   * **The second fact reaches nobody's feed today, and that is stated rather than papered over.**
   * The org path's actor is `service:identity`, so `userFromActor` returns null and `classify`
   * demotes the record to internal — correct, because there genuinely is no user on the envelope
   * and a classifier may not read a database to find one. The owner exists: `api_keys.created_by`
   * is on the row `revokeOrgKeys` is already updating. The repair is one field on devplatform's
   * payload, and it is filed for micro-devplatform. `notify` cannot close it either — `forUser`
   * answers `no_recipient` for a `service:` actor and that refusal is correct — so today a mass
   * revocation is an operator's record and nobody's notification.
   *
   * Both branches key off `userFromActor(event) !== null` rather than off `parseActor` again, so
   * the type and the owner can never disagree: there is exactly one reader, and "the platform did
   * this" means precisely "no user is attributed" rather than approximately.
   */
  'devplatform.key.revoked': {
    payloadKeys: ['display', 'reason'],
    category: 'api',
    type: (event) =>
      userFromActor(event) === null ? 'api.key_revoked_by_platform' : 'api.key_revoked',
    visibility: 'user',
    // NOT userFromKey: `apikeys.ts:371` passes `key.id` (registry `keyedBy: 'key_id'`), a uuid.
    userId: userFromActor,
    summary: (event) => {
      const display = text(event, 'display', 48)
      const named = display ? ` ${display}` : ''
      const reason = text(event, 'reason', 64)
      const because = reason ? ` Reason given: ${reason}.` : ''
      return userFromActor(event) === null
        ? `The API key${named} was revoked by CloudsForge and stopped working immediately. Anything using it is now failing.${because}`
        : `The API key${named} was revoked and stopped working immediately. Anything using it is now failing.${because}`
    },
  },
  /* ── tessera: seven topics, every one of them subject-keyed ────────────────────────────────
   *
   * All seven arrived in the registry together and none of them was classified, which is the
   * failure the `satisfies` on this table exists to produce: `pnpm typecheck` went red naming
   * eight missing keys, in CI, on the first run of it that was allowed to execute a step. They had
   * been landing in `unclassified` quarantine — which is the designed behaviour and not a loss,
   * so the records are all still here to be reclassified.
   *
   * NOT ONE of them carries a bare uuid for its owner. Tessera is subject-keyed throughout: every
   * payload spells its party `user:<uuid>`, so `userFromPayload` finds nothing on all seven and
   * `userFromKey` is wrong on all seven (the keys are parcels, objects, wards — never people).
   * `userFromSubjectField` is the only correct reader here, and the field it is given is named
   * per topic below rather than defaulted, because on three of them there are TWO subjects and
   * only one of them is the person whose news this is.
   *
   * Where a topic has two parties, the choice matches `micro-notify`'s catalogue rather than
   * being decided a second time here — the estate should not hold two opinions about whose event
   * this is. Each entry cites the rule it follows.
   * ------------------------------------------------------------------------------------------ */
  'tessera.parcel.claimed': {
    payloadKeys: ['ownerSubject', 'tier', 'tiles'],
    category: 'ownership',
    type: 'ownership.parcel_claimed',
    visibility: 'user',
    // `ownerSubject`, the claimant. One party only: the ward is not a person.
    userId: userFromSubjectField('ownerSubject'),
    summary: (event) => {
      const tier = text(event, 'tier', 32)
      const tiles = payloadOf(event)['tiles']
      const size = typeof tiles === 'number' && Number.isInteger(tiles) && tiles > 0 ? ` of ${tiles} tiles` : ''
      return tier ? `You claimed a ${tier} parcel${size}.` : `You claimed ground${size}.`
    },
  },
  /**
   * The owner's warning, and the ONLY warning they get.
   *
   * `notify` says it plainly (`catalogue.ts:1230`): a contest is only insertable after 90 days
   * with no visitor or edit plus 30 more, so the owner is by construction not there, and
   * `tessera.parcel.transferred` is "the same news arriving after it is too late to matter". The
   * payload puts `ownerSubject` before `challengerSubject` deliberately — tessera's own comment
   * calls it "the party this event is ABOUT: whoever is losing ground" — and this reads that one.
   */
  'tessera.parcel.fallowed': {
    payloadKeys: ['ownerSubject'],
    category: 'ownership',
    type: 'ownership.parcel_contested',
    visibility: 'user',
    userId: userFromSubjectField('ownerSubject'),
    summary: () =>
      'A parcel you hold has gone fallow and somebody has opened a claim on it. Visit or edit it to keep it.',
  },
  /**
   * **THE DISPOSSESSED OWNER'S RECORD, not the new owner's**, and one record is all there is.
   *
   * Two subjects on the payload, and `notify` chose `fromSubject` with a reason this file has no
   * grounds to overrule (`catalogue.ts:1188-1200`): a contest "takes ground off its owner while
   * they are not there — the loser did nothing, is told by nothing else, and finds out by opening
   * Tessera and looking for land that is gone". The winner opened the contest and was waiting for
   * it.
   *
   * Where notify then answers `not_applicable` for `reason: 'trade'` — declining to confirm a
   * thing two people just did on purpose — a FEED is not a notification and does not have that
   * option: a timeline that omitted the trade would show land leaving somebody's hands with no
   * entry saying so. So both reasons are recorded and `type` separates them, because "you were
   * dispossessed" and "you transferred it" must not render with the same chrome.
   *
   * The receiving half is not representable: a classifier returns one record and may not read a
   * database, so it cannot write the buyer's entry too. Same limit as `market.listing.sold`.
   */
  'tessera.parcel.transferred': {
    payloadKeys: ['fromSubject', 'reason'],
    category: 'ownership',
    type: (event) =>
      text(event, 'reason', 32) === 'contest' ? 'ownership.parcel_lost' : 'ownership.parcel_transferred',
    visibility: 'user',
    userId: userFromSubjectField('fromSubject'),
    summary: (event) =>
      text(event, 'reason', 32) === 'contest'
        ? 'A parcel you held was taken by a resolved contest. It had been fallow for 120 days.'
        : 'A parcel you held changed hands.',
  },
  'tessera.object.fired': {
    payloadKeys: ['authorSubject', 'category', 'c2pa'],
    category: 'ownership',
    type: 'ownership.object_fired',
    visibility: 'user',
    // `authorSubject`. NOT the actor and NOT the key: the key is the object's own id, and tessera's
    // emit comment says why ("an actor is not a discriminator").
    userId: userFromSubjectField('authorSubject'),
    summary: (event) => {
      const category = text(event, 'category', 32)
      // MEASURED, not asserted — tessera's word for the field, and the reason it is reported at
      // all rather than assumed true.
      const c2pa = payloadOf(event)['c2pa'] === true ? ' Its provenance is signed.' : ''
      return category ? `A ${category} came out of the Kiln.${c2pa}` : `An object came out of the Kiln.${c2pa}`
    },
  },
  'tessera.object.anchored': {
    payloadKeys: ['authorSubject', 'transactionHash'],
    category: 'ownership',
    type: 'ownership.object_anchored',
    visibility: 'user',
    // `authorSubject` again, and tessera's emit says the same thing in the other direction: the
    // audit table reads THIS field rather than the envelope key, "the custody defect in reverse".
    // The actor here is `system` — the anchor is written by a job, not by the author.
    userId: userFromSubjectField('authorSubject'),
    summary: (event) => {
      const hash = text(event, 'transactionHash', 66)
      return hash
        ? `Your authorship of an object was written to Hearth, in transaction ${hash}.`
        : 'Your authorship of an object was written to Hearth.'
    },
  },
  /**
   * NOBODY'S FEED. The payload is a ward id, a slug, an archetype, an ordinal and a tile count,
   * and names no user at all; the actor is `system`.
   *
   * `aetherholm.season.opened` and `community.proposal.opened` above, exactly — and `notify`
   * records the same refusal for the same topic in the same words ("opening a ward is inventory").
   * `internal`, and the owner is `null` rather than guessed from the ward.
   */
  'tessera.ward.opened': {
    payloadKeys: ['name', 'archetype'],
    category: 'community',
    type: 'community.ward_opened',
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const name = text(event, 'name', 48)
      const archetype = text(event, 'archetype', 32)
      if (name && archetype) return `A new ${archetype} ward opened: ${name}.`
      return name ? `A new ward opened: ${name}.` : 'A new ward opened.'
    },
  },
  /**
   * The parcel OWNER's record — the party being paid — and not the person who booked.
   *
   * `ownerSubject` is first of the pair on the payload for that reason, and `notify`'s rule reads
   * the same field. Tessera's emit also refuses to publish the caller's figure: `priceWei` is the
   * owner's number, "publishing `input.escrowedWei` instead would put an unverified figure on the
   * bus".
   *
   * `amount` and `assetCode` on the record stay NULL, deliberately. `classify` reads `amount` or
   * `price` and this payload has neither — it has `priceWei`, and wei is not what the `amount`
   * column holds. Filing 5000000000000000000 under an amount a feed renders beside a code would
   * show a user a number eighteen orders of magnitude wrong, so the price is stated in the summary
   * in EMBER, converted here and nowhere else, or omitted entirely if it does not parse.
   */
  'tessera.venue.booked': {
    payloadKeys: ['ownerSubject', 'hours', 'priceWei'],
    category: 'market',
    type: 'market.venue_booked',
    visibility: 'user',
    userId: userFromSubjectField('ownerSubject'),
    summary: (event) => {
      const hours = payloadOf(event)['hours']
      const span = typeof hours === 'number' && Number.isInteger(hours) && hours > 0 ? ` for ${hours} hours` : ''
      const price = emberFromWei(payloadOf(event)['priceWei'])
      const paid = price === null ? '' : ` You earned ${price} EMBER.`
      return `Your venue was booked${span}.${paid}`
    },
  },
} as const satisfies Readonly<Record<TopicName, TopicClassifier>>)

/* ------------------------------------------------------------------ classification */

/**
 * `urn:cloudsforge:<producer>:<aggregate>:<key>`.
 *
 * Built from the topic rather than from a payload field, so a producer cannot accidentally emit a
 * URN naming another service's resource — the topic namespace is the ownership boundary and
 * contracts-events already refuses an event whose producer does not own its topic.
 */
export function subjectUrnFor(producer: ProducerService, aggregate: string, key: string): string {
  return `urn:cloudsforge:${producer}:${aggregate}:${key}`
}

/**
 * Classify a delivered event.
 *
 * `known` is false when the topic parsed and validated but is not in this build's registry — a
 * consumer that is behind its producers. The record is still written, in quarantine, because
 * losing an event silently is worse than filing it badly: the payload is kept, the topic is
 * recorded, and the row can be reclassified from data that was never thrown away.
 */
export function classify(envelope: EventEnvelope, known: boolean): Classified {
  const parsed = parseTopicName(envelope.topic)
  const aggregate = parsed.ok ? parsed.value.aggregate : 'unknown'
  const subjectUrn = subjectUrnFor(envelope.producer, aggregate, envelope.key)

  if (!known) {
    // `null` is the quarantine rule, not an empty allowlist: there is no declaration to check
    // against, so the payload keeps its structure and its identifiers and loses its prose. See
    // `redact.ts` — dropping it outright would destroy the reclassification the quarantine exists
    // for, and keeping it verbatim is the defect this whole path was.
    const redaction = redactPayload(envelope.payload, null)
    return {
      category: UNCLASSIFIED,
      type: envelope.topic,
      // Not guessed. A user id read out of an unrecognised payload is a guess about a schema
      // this build has never seen, and a wrong one puts another user's event in a feed.
      userId: null,
      subjectUrn,
      summary: `An event this build does not yet classify: ${envelope.topic}.`,
      amount: null,
      assetCode: null,
      visibility: 'internal',
      payload: redaction.payload,
      redactedKeys: redaction.dropped,
    }
  }

  const classifier: TopicClassifier = CLASSIFIERS[envelope.topic]
  const userId = classifier.userId(envelope)
  const redaction = redactPayload(envelope.payload, classifier.payloadKeys)
  return {
    category: classifier.category,
    type: typeof classifier.type === 'function' ? classifier.type(envelope) : classifier.type,
    userId,
    subjectUrn,
    summary: classifier.summary(envelope),
    amount: amount(envelope) ?? amount(envelope, 'price'),
    assetCode: asset(envelope),
    // A record with no owner cannot be in anybody's feed, whatever the classifier says. Without
    // this, a `settlement.withdrawal.stuck` with no user in its payload would be a `user`-visible
    // record that no user can ever see, which reads on a dashboard as a delivered notification.
    visibility: userId === null ? 'internal' : classifier.visibility,
    payload: redaction.payload,
    redactedKeys: redaction.dropped,
  }
}

/** Every topic this build classifies. Equal to the registry by construction. */
export const CLASSIFIED_TOPICS: readonly TopicName[] = Object.freeze(
  Object.keys(CLASSIFIERS) as TopicName[],
)

/** Exported so a test can assert the table and the registry have not diverged. */
export const REGISTERED_TOPIC_COUNT = Object.keys(TOPICS).length
