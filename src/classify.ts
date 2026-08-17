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
// A runtime dependency, not a dev one: `seasonRewardSummary` below asks this list a question on
// the classification path, so that no rule can name a wound-down asset to a player however the
// producer spells its payload. See that function's header for the whole argument.
import { RETIRED_ASSETS } from '@cloudsforge/contracts-chain'
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
   * notification fires for every reason except `signed_out` (notify/src/catalogue.ts) — and a
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

/**
 * A numeric field, as a string. **The SCALE is not known here** — see `money` below, which is what
 * every money path must use. Kept as a string throughout: a feed that rounded a balance would be
 * a lie.
 */
function amount(envelope: EventEnvelope, field = 'amount'): string | null {
  const value = payloadOf(envelope)[field]
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return value
  return null
}

function asset(envelope: EventEnvelope, field = 'assetCode'): string | null {
  const value = payloadOf(envelope)[field]
  return typeof value === 'string' && /^[A-Z][A-Z0-9:_-]{0,31}$/.test(value) ? value : null
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ── THE PRODUCERS WHOSE `amount` IS SMALLEST UNITS, AND THE EVIDENCE FOR EACH ─────────────────
 *
 * A payload field called `amount` is not a unit. Half the estate spells a decimal figure with
 * that name and half spells an integer count of the asset's indivisible units with it, and the
 * two differ by up to eighteen orders of magnitude with nothing on the wire to tell them apart:
 * `2.5` and `2500000000000000000` are both `/^\d+(\.\d+)?$/`, and neither carries a `decimals`.
 *
 * A classifier may not read a database (see the header), so this file cannot convert. What it CAN
 * do is know which producers speak which dialect, because the producer is on the envelope and the
 * topic namespace is the ownership boundary — `contracts-events` already refuses an event whose
 * producer does not own its topic, so `envelope.producer` is as trustworthy as the topic name.
 *
 * The set is keyed on the PRODUCER rather than on a list of topics deliberately: a wallet topic
 * registered tomorrow is smallest units on the day it lands, and a topic list would have to be
 * remembered. This is the same argument as the `satisfies Record<TopicName, …>` above — make the
 * default safe, rather than trusting the next person to add a line.
 *
 *   - `wallet`      — `toWithdrawal` stores `amount: row.amount` and separately computes
 *                     `formatAmount(BigInt(row.amount), decimals)` (`wallet/src/withdrawals.ts`);
 *                     `wallet/src/deposits.ts` emits the same pair. The raw side is the
 *                     one named `amount`.
 *   - `settlement`  — `units()` refuses anything but `/^\d+$/` and calls it "a decimal string of
 *                     smallest units" (`settlement/src/withdrawals.ts`); `base(row)` puts
 *                     `row.amount.toString()` on every outbound payload (`withdrawals.ts`).
 *   - `ledger`      — `postings.amount` is `numeric(78,0)` (`ledger/src/migrations.ts`), an
 *                     integer column with no fractional part to hold a decimal in.
 *   - `market`      — `orders.amount` and `bids.amount` are `numeric(78,0)` too
 *                     (`market/src/migrations.ts,402`), and `orderEventPayload` emits
 *                     `order.amount.toString()` (`market/src/orders.ts`).
 *   - `trade`       — joined with micro-org#345, and the best-evidenced of the five. Every money
 *                     column in `trade/src/migrations.ts` is `numeric(78,0)` — allocation, cash,
 *                     equity, high_water_mark, fee_owed, fee_paid, shards, collected — and
 *                     `trade/src/money.ts` is `bigint` throughout with a header that exists
 *                     because the service it replaces read every one of those columns into a
 *                     JavaScript `number`. Its three units are named there and all three are
 *                     integers: Shards (no sub-unit at all, 100 to the USD), base units, and a
 *                     price scaled by `RATE_SCALE`. There is no decimal on any trade payload.
 *
 * Adding a producer here is a one-line change and removing one needs the same kind of citation.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
const SMALLEST_UNIT_PRODUCERS: ReadonlySet<ProducerService> = new Set<ProducerService>([
  'wallet',
  'settlement',
  'ledger',
  'market',
  'trade',
])

/**
 * **A figure that may be shown to a person as money, or null when there is not one.**
 *
 * The only reader a summary or the `amount` COLUMN may use. `amount()` above answers "what number
 * is on the payload"; this answers the question that actually matters, "what number may be
 * rendered beside an asset code", and those are not the same question.
 *
 * Three outcomes, in order:
 *
 * 1. **The producer already converted it.** `<field>Formatted` is the estate's spelling for the
 *    decimal side of the pair — wallet emits `amount`/`amountFormatted` together and only wallet
 *    knows the asset's `decimals`, because only wallet can call `chainSpec`. Where it is on the
 *    payload it is authoritative and it is used.
 * 2. **The producer deals in smallest units and did not convert it.** Null — "not stated". Not a
 *    guess at eighteen decimals, which is right for EMBER and SHARD and wrong for USDC, and not
 *    the raw integer either. This is the refusal `tessera.venue.booked` and
 *    `settlement.sweep.completed` already wrote out longhand, applied once for every topic.
 * 3. **Anything else** is decimal on the wire and passes through unchanged.
 *
 * ── WHY THE `amount` COLUMN GOES THROUGH THIS TOO, WHICH IS A REVERSAL ────────────────────────
 *
 * Two comments below used to say the figure "still reaches the record's own columns, where it is
 * typed and not prose", and treated the column as a safe place to put a number of unknown scale.
 * **That was wrong, and there is a file that proves it:** `hub-web/src/pages/activity.tsx,202`
 * renders `formatAmount(record.amount)` immediately followed by `record.assetCode`, and
 * `hub-web/src/lib/format.ts` is a DECIMAL formatter with a thousands separator. So a
 * smallest-units integer in that column is not typed data at rest — it is
 * "2,500,000,000,000,000,000 SHARD" in the same feed row as the summary, one hop later. The
 * column is prose with extra steps, so it gets the prose rule.
 *
 * Nothing is silently lost by that: every classifier that cares declares `amount` in its
 * `payloadKeys`, so the producer's own figure survives verbatim in `activity_records.payload`,
 * where it is a labelled field in a JSON document and no frontend renders it as money.
 */
function money(envelope: EventEnvelope, field = 'amount'): string | null {
  // BOTH reads happen, always, and unconditionally rather than behind the early return. The
  // "declared or not read" test drives this file against a recording Proxy in both directions, so
  // a short-circuit here would make a classifier that legitimately declares `amount` fail as
  // over-declared the moment its producer joined the set above.
  const formatted = amount(envelope, `${field}Formatted`)
  const raw = amount(envelope, field)
  if (formatted !== null) return formatted
  if (raw === null) return null
  return SMALLEST_UNIT_PRODUCERS.has(envelope.producer) ? null : raw
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

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ── WHAT A SEASON REWARD IS CALLED, AND WHY THE UNIT IS NOT WRITTEN INTO THE SENTENCE ─────────
 *
 * Both reward rules — `worlds.reward.granted` and `emberkin.reward.granted` — used to end
 *
 *     `You earned ${amount} Shards.`
 *
 * with the unit typed into the copy. SHARD is RETIRED: `RETIRED_ASSETS = Object.freeze(['SHARD'])`
 * (`contracts/packages/chain/src/index.ts:58`), whose own comment is that nothing may be **newly**
 * denominated in it — and a season reward is exactly a new denomination, announced to the player
 * who has just been given it. micro-org #227 is the sweep that found this; it spans seven
 * repositories and it is the third time a retired asset has reached a user surface (#15, #182).
 *
 * ── WHAT THE PRODUCERS ACTUALLY PUT ON THE WIRE, READ AT BOTH EMIT SITES ──────────────────────
 *
 *   - `worlds/src/rewards.ts:555-574` (`grantReward`) emits `{ rewardId, seasonId, titleId,
 *     userId, reason, amountShards, journalEntryId, budgetRemainingShards }`.
 *   - `emberkin/src/seasons.ts:136-142` (`grantSeasonReward`) emits `{ seasonId, userId, reason,
 *     amount, journalEntryId }`.
 *
 * **Neither carries an asset code.** The old sentence did not read one either — "Shards" was a
 * word in THIS file, and the only thing on either payload pointing at an asset was the NAME of
 * worlds' `amountShards` field. A field name is the producer's wire contract and no person ever
 * reads it; a summary is read by a person. Those are not the same claim, which is why reading a
 * field called `amountShards` below is not the defect being closed here.
 *
 * ── AND THE OBVIOUS SUBSTITUTION — EMBER FOR SHARDS — WOULD HAVE BEEN A WORSE LINE ────────────
 *
 * Both services credit the player in SHARD today, at HEAD: `rewardPostings` builds every posting
 * with `assetCode: 'SHARD'` against `engagementAccount(<programme>, 'SHARD')` —
 * `worlds/src/ledgerclient.ts:155-183`, `emberkin/src/ledgerclient.ts:116-141`. So "You earned
 * 250 EMBER." would be a feed row the ledger contradicts, and a unit this service picked on
 * behalf of the service that moved the money. Where the engagement programmes re-denominate is
 * #226 and it is theirs to decide. #227's own later paragraph is the accurate description of
 * these two lines: surfaces labelling "genuinely SHARD-denominated ledger data … need the
 * underlying re-denomination, not a find-and-replace".
 *
 * ── SO: AN AMOUNT AND A CODE THE PRODUCER SENT, OR NO UNIT AND NO FIGURE ──────────────────────
 *
 * A quantity with no unit is not a smaller version of the truth. "You earned 250." is a number
 * the reader supplies their own unit for — the same shape `money`'s header above refuses for
 * scale and `settlement.sweep.completed` refuses longhand. So the figure travels with its unit or
 * it does not travel: an amount AND an asset code the producer sent, else the sentence that names
 * the reward without quantifying it. Nothing is lost that was ever knowable here — both payloads
 * declare their amount field, so the producer's own figure survives verbatim in
 * `activity_records.payload`, in its own units, where it is a labelled field rather than money.
 *
 * The asset-code branch is DEAD against both of today's payloads and is written anyway. It is
 * what makes this outlive #226: the day either producer puts `assetCode` on its event both
 * summaries begin reading "250 EMBER" with no edit here, and no unit will ever have been typed
 * into this file to get there. Same shape as `wallet.withdrawal.requested`, which declines a
 * figure until wallet emits `amountFormatted` and then prints it with no change in this file.
 *
 * ── A RETIRED CODE IS REFUSED EVEN WHEN THE PRODUCER DOES SEND IT, WHICH IS A JUDGEMENT ───────
 *
 * Elsewhere in this file rendering SHARD is CORRECT: `wallet.deposit.confirmed` says "A SHARD
 * deposit was confirmed and credited." from the code on its payload, because a deposit is a past
 * fact that really was denominated that way — the argument that also keeps
 * `mint-web/src/lib/format.ts` showing a pre-migration order as "2,500 SHARD". A reward is not
 * that. It is news about something a player has just been given, in an asset the estate is
 * winding down. So this ONE reader consults `RETIRED_ASSETS` — the estate's LIST, never the
 * string "SHARD", so it extends itself the next time an asset is retired.
 *
 * ── ONE FUNCTION, BECAUSE THE TWO RULES DISAGREEING IS PART OF WHAT #227 REPORTS ──────────────
 *
 * micro-notify's row of #227 reaches the same answer for the same two topics from the other side
 * of the bus, independently: `rewardNameOf` (`notify/src/catalogue.ts:521`, on that repository's
 * `fix/reward-name-derives-its-unit`) renders "a reward" where this renders "You earned a season
 * reward.", refuses a retired code on the delivery path, and carries the same dead asset-code
 * branch. Two services describing one event in two different denominations is how a player's feed
 * and their email end up disagreeing, and it is what #227 §2 reports about this pair: notify
 * appended "Shards" on emberkin's rule and nothing at all on worlds'. Neither was a decision;
 * each was what its author wrote on the day.
 *
 * `amountField` is a parameter rather than a probe of every spelling, and that is the allowlist
 * rather than taste: a classifier may not read a payload key it has not declared, and reading
 * emberkin's `amount` on worlds' topic — or worlds' `amountShards` on emberkin's — either fails
 * that test or forces a declaration claiming a payload carries a field it does not. `assetCode`
 * needs no such parameter: it is one of the generic keys `classify` already probes on every
 * topic for the record's own column.
 *
 * ── ONE THING THIS DOES NOT FIX, RECORDED RATHER THAN SMUGGLED IN ─────────────────────────────
 *
 * emberkin's `amount` still reaches the record's `amount` COLUMN through `money` — emberkin is
 * not a smallest-units producer — while its `assetCode` column stays null, and
 * `hub-web/src/pages/activity.tsx:207-213` renders the figure with an empty code beside it. That
 * is a figure without a unit one column to the right of the one repaired here, and it is the same
 * hole: it closes when the producers name their asset, which is #226's re-denomination, not a
 * classifier's to invent.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
function seasonRewardSummary(envelope: EventEnvelope, amountField: string): string {
  // `amount` plus the producer set rather than `money`: `money` probes `<field>Formatted`, which
  // for worlds spells `amountShardsFormatted` — a field worlds does not send and this file may not
  // declare, because a declaration states that the payload really carries it. The half of `money`'s
  // rule that can bite here is kept as it is: if either producer ever emits smallest units it joins
  // SMALLEST_UNIT_PRODUCERS and this declines the figure with no change in this function.
  const raw = amount(envelope, amountField)
  const value = raw !== null && SMALLEST_UNIT_PRODUCERS.has(envelope.producer) ? null : raw
  const code = asset(envelope)
  // `asset` already requires `/^[A-Z]…/`, so there is no case folding to do; the cast is because
  // `RETIRED_ASSETS` is `readonly AssetCode[]` and this string is a producer's, not this file's —
  // narrowing it to `AssetCode` first would assert the very thing being asked.
  const retired = code !== null && (RETIRED_ASSETS as readonly string[]).includes(code)
  if (value !== null && code !== null && !retired) return `You earned ${value} ${code}.`
  return 'You earned a season reward.'
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
 * It is used by exactly six topics — `trade.bot.created`, `trade.bot.started`, `trade.bot.paused`,
 * `trade.fee.settled`, `devplatform.key.issued` and `devplatform.key.revoked` — and each one cites
 * the site in its producer that proves the actor is the subject of the news rather than merely its
 * cause. Nothing else may use it without doing the same, and `unit.test.ts`'s actor rule holds every
 * other topic in the registry to that refusal.
 *
 * **trade's four are the easy case and it is worth saying why, so the next author does not read
 * them as a precedent for the hard one.** All four take their actor from the BOT ROW rather than
 * from the caller — `bots.ts` and `fees.ts` build it from `bot.userId`, not from the session — so
 * the actor is the owner whoever pressed the button and whatever route reached the emit. That is a
 * different and much stronger claim than "the person who acted is usually the person affected",
 * which is the claim that fails on `aetherholm.battle.resolved`. trade's other three topics do NOT
 * qualify, and `trade.fill.settled` stopped qualifying for a DIFFERENT reason than it used to. It
 * was emitted with no actor at all until micro-trade `ee5e189`, so there was nothing on the
 * envelope to read; it now emits `user:${fill.userId}` off the fill row, the same shape as the four
 * above, and it still does not use this reader — because that same change put `userId` on the
 * payload, and a payload that names the user needs no argument at all. That is the rule this reader
 * is quarantined by, stated in the direction that matters: `userFromActor` is what a topic falls
 * back to when the payload names nobody, not the better answer when both are available.
 * `trade.order.filled` and `trade.transfer.settled` are the same case and always were.
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
 * membership model is subject-keyed (`community/src/server.ts` passes `caller.subject`). So
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
 * The four keys are every value identity actually passes — `identity/src/server.ts` (password
 * changed) (password reset) (signed out everywhere) and/
 * `sessions.ts` (signed out). The fifth case has no constant: `server.ts` burns a refresh
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
 * agree with the consumer that actually moves the money: `wallet/src/server.ts` writes
 * `refundable: payload['refundable'] === true` for the stated reason that refunding a payment
 * which really landed pays the user twice. A timeline that said "the money is on its way back"
 * where wallet held the funds and paged an operator would be a feed entry contradicting the
 * balance the user is looking at on the same screen.
 */
function isRefundable(envelope: EventEnvelope): boolean {
  return payloadOf(envelope)['refundable'] === true
}

/**
 * Whether a revocation took the whole external wallet link, or one permission off it.
 *
 * `wallet/src/links.ts` types the field `Authorisation | null` and §3.2 spells out what the
 * `null` means: "'disconnect a wallet' is revoking all of them plus the link". So an absent or
 * null `authorisation` is the WHOLE link, and it is the more serious of the two — which is the
 * right way round for a field that may also be missing because a producer stopped sending it.
 */
function revokedWholeLink(envelope: EventEnvelope): boolean {
  const value = payloadOf(envelope)['authorisation']
  return typeof value !== 'string' || value.length === 0
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
   * (`identity/src/emailVerification.ts`) and two of those fields are ones this table must
   * never hold: `email` is a direct identifier, and `verifyUrl` is a **live single-use credential**.
   * Identity's own header accepts putting the link on the bus because `notify` has to send it and
   * prunes what it stores; activity subscribes to every topic under AD-11, needs neither field for
   * anything, and until `redact.ts` existed would have stored both verbatim, for ever, in a row
   * nothing deleted. `payloadKeys` is `['linkable']` and that is the entire difference.
   *
   * `account`, not `security`. This is the account not yet being finished — `notify` renders it as
   * `account.verify_email` (`notify/src/catalogue.ts`) — and a user reading their timeline for
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
    // Keyed by user_id, as the registry says and as the emit does (`emailVerification.ts`).
    userId: userFromKey,
    summary: (event) =>
      payloadOf(event)['linkable'] === true
        ? 'We sent a link to verify your email address. It can be used once and expires in 24 hours.'
        : 'Your email address was asked to be verified, but no link could be built for it.',
  },
  /**
   * The sibling of the entry above, and classified differently on purpose.
   *
   * Its payload is `{ userId, handle, email, expiresAt, issuedByOperator, linkable, resetUrl? }`
   * (`identity/src/passwordReset.ts`), and three of those are fields this table must never hold:
   * `email` and `handle` are direct identifiers, and `resetUrl` is a **live single-use credential**
   * — a thirty-minute one, which is a shorter fuse than the verification link's twenty-four hours
   * and therefore a worse thing to have copied into a row nothing deletes. `payloadKeys` names two
   * fields and neither of them is any of those three.
   *
   * `security`, not `account`. The entry above argues for `account` because email verification is
   * the account not yet being finished, and that argument does not transfer: this is a request to
   * REPLACE THE CREDENTIAL, and `contracts/packages/events/src/audit.ts` audits it on exactly that
   * reasoning — "who asked to replace the credential on this account, and when" is where every
   * dispute about a compromised account starts. A user scanning their own timeline because they
   * think someone got in wants this beside the session revocations and the MFA changes, not beside
   * their registration. Both categories retain for 730 days (`retention.ts`: `personal`), so this
   * chooses a shelf and not a lifetime.
   *
   * `issuedByOperator` is declared and read, and that is the whole reason it is declared. The
   * producer put a boolean on the event rather than the operator's id — "whether an operator issued
   * it, never WHICH operator" (`passwordReset.ts`) — so the one fact a user needs is available
   * without naming a staff member in somebody's feed. "You asked for this" and "support started
   * this for you" are different events to the person reading the line, and collapsing them would
   * make the timeline useless for the case it exists to serve.
   *
   * The summary never carries the link and never names the address, and `linkable` is always
   * present by the producer's design, so a deployment with no `IDENTITY_ACCOUNT_URL` reads as the
   * different fact it is rather than as a silent nothing. micro-org#263.
   */
  'identity.password.reset_requested': {
    payloadKeys: ['linkable', 'issuedByOperator'],
    category: 'security',
    type: 'security.password_reset_requested',
    visibility: 'user',
    // Keyed by user_id, as the registry says and as the emit does (`passwordReset.ts`).
    userId: userFromKey,
    summary: (event) => {
      const payload = payloadOf(event)
      const who = payload['issuedByOperator'] === true ? 'Support started' : 'You asked for'
      return payload['linkable'] === true
        ? `${who} a password reset for your account. The link can be used once and expires in 30 minutes.`
        : `${who} a password reset for your account, but no link could be built for it.`
    },
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
    // (`identity/src/sessions.ts`) and names the user in the payload. The key IS a uuid, so
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
    // (contracts/packages/events/src/index.ts, identity/src/sessions.ts) and a session id
    // IS a uuid, so userFromKey would return it as the "user" and every revocation would land in
    // nobody's feed — silently, exactly as identity.session.created did. The payload names the
    // user (`identity/src/sessions.ts`).
    userId: userFromPayload,
    summary: (event) => REVOCATION_SUMMARIES[revocationReason(event)] ?? UNKNOWN_REVOCATION,
  },
  'identity.device.added': {
    payloadKeys: ['userId', 'device'],
    category: 'security',
    type: 'security.device_added',
    visibility: 'user',
    // Same repair as session.created: identity keys this by DEVICE id (`identity/src/sessions.ts`)
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
    // Keyed by user_id, as the registry says and as the emit does (`identity/src/mfa.ts`).
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
    // `postings.amount` is `numeric(78,0)` (`ledger/src/migrations.ts`) — an integer column,
    // so ledger is in `SMALLEST_UNIT_PRODUCERS` and `money` returns null here today. The fallback
    // therefore has to carry the asset and the kind rather than shrug: "A ledger entry was posted"
    // with no other word in it is a feed row that tells its reader nothing they did not know.
    summary: (event) => {
      const value = money(event)
      const code = asset(event)
      const kind = text(event, 'kind', 32)
      const qualified = kind ? ` (${kind})` : ''
      if (value && code) return `${value} ${code} moved${qualified}.`
      return `A ledger entry was posted against your account${code ? ` in ${code}` : ''}${qualified}.`
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
   * `ledger.entry.posted` (`ledger/src/entries.ts`). A reconciliation that finishes announces
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
    // `amount`, not `money`, and it is the one deliberate exception in the file. A drift is a
    // residual in the ledger's own units, printed with no asset code beside it, to an operator who
    // is about to go and read `postings` — nobody is being shown a price. Passing it through
    // `money` would blank the only fact the sentence carries, to protect a reader who does not
    // exist: this topic has `internal` visibility and no user, and nothing emits it (see above).
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
    // Keyed by WALLET id (`wallet/src/wallets.ts`, registry keyedBy `wallet_id`); the payload
    // names the user (`wallet/src/wallets.ts`).
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
  /**
   * **The one money topic in the estate that can print its figure, because its producer sent one.**
   *
   * `amountFormatted` is declared and read, and `money` prefers it over the raw `amount` beside
   * it. wallet emits the pair from one place (`wallet/src/deposits.ts`) and it is the only
   * party that can: the conversion needs `chainSpec(assetCode).decimals`, and a classifier may not
   * go and look that up. Where the pair exists, the user gets the sentence they want.
   *
   * The fallback is not the old one. "A deposit was confirmed." threw away the asset code as well
   * as the figure, and the code is on the payload, is not a scale question and is the difference
   * between "some money arrived" and "your SHARD arrived". Only the number is unknown.
   */
  'wallet.deposit.confirmed': {
    payloadKeys: ['userId', 'amount', 'amountFormatted', 'assetCode'],
    category: 'deposit',
    type: 'deposit.confirmed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = money(event)
      const code = asset(event)
      if (value && code) return `Deposit of ${value} ${code} confirmed and credited.`
      return code ? `A ${code} deposit was confirmed and credited.` : 'A deposit was confirmed.'
    },
  },
  /**
   * **The deposit topic whose news is that a balance did NOT change.**
   *
   * A token transfer reached its confirmation depth at a user's deposit address and no ledger
   * entry exists for it (`wallet/src/deposits.ts`, `token_deposit_unsupported`). Every other
   * `deposit` row in this feed is money that arrived; a user who reads this one as the same kind
   * of news waits for a credit that is never coming, so the sentence says NOT credited, says it
   * is not in the balance, and says it cannot be withdrawn — the registry's own description of
   * the topic, in the user's words.
   *
   * **No figure, and here that is not `money` being cautious — the figure does not exist.**
   * wallet is in `SMALLEST_UNIT_PRODUCERS` so `money` would decline it anyway, but this payload
   * is the one case where nobody downstream could rescue it: it carries the TOKEN's own smallest
   * units with no `amountFormatted` and no `decimals`, because wallet has no source for the
   * decimals of a contract it does not know — `assetDecimals` throws for a `TOKEN:` code rather
   * than assume 18, Tether being six. `amount` is therefore not declared either, and that is
   * deliberate rather than an omission: an undeclared key is dropped at ingest, and this integer
   * must be, because the record's `amount` COLUMN is rendered as a decimal figure beside an asset
   * code (`hub-web/src/pages/activity.tsx`). Rendering 250731000 as an amount of USDT would be
   * off by six orders of magnitude in the user's favour. The one surface that shows this integer
   * shows it marked "raw units" (the wallet page's uncredited-token panel, micro-org#200).
   *
   * **The token is named by contract address and never by a symbol.** A symbol is whatever the
   * contract chose to return and two contracts may both answer "USDT"; the address is the only
   * identifier that separates the token a user holds from one impersonating it, and this row is
   * what a support conversation about the missing money will be conducted from.
   *
   * `userFromPayload`, as every wallet topic: keyed by `wallet_id`, a uuid, so `userFromKey`
   * would not fail here — it would return a well-formed, queryable, WRONG id.
   */
  'wallet.deposit.token_uncredited': {
    payloadKeys: ['userId', 'chain', 'network', 'tokenAddress'],
    category: 'deposit',
    type: 'deposit.token_uncredited',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      // Every declared field is read before anything branches, for the reason
      // `wallet.deposit_address.assigned` states: the allowlist test drives this against a payload
      // whose every key is `undefined`, and a key read only inside a taken branch looks
      // declared-but-never-read on the run where that branch is not taken.
      const chain = text(event, 'chain', 24)
      const network = text(event, 'network', 24)
      const token = text(event, 'tokenAddress', 64)
      const which = token ? ` (contract ${token})` : ''
      const where = chain ? ` on ${chain}${network ? ` ${network}` : ''}` : ''
      return `A token${which} reached your deposit address${where} and was NOT credited: it is not in your balance and cannot be withdrawn.`
    },
  },
  /**
   * **No figure, and it is wallet's payload that decides that rather than a preference here.**
   *
   * `WithdrawalRequestedPayload` sends `amount`, `fee` and `net` and nothing formatted
   * (`wallet/src/withdrawals.ts`) — the same row that `toWithdrawal` twenty lines earlier
   * converts for its API response, so the omission is an inconsistency in wallet rather than a
   * scale that does not exist. Until `amountFormatted` is on this payload the honest sentence
   * names the asset and declines the number; the moment wallet adds it, `money` picks it up and
   * this summary starts printing "Withdrawal of 2.5 SHARD requested." with no change here.
   *
   * `amount` stays declared. It is read (by `money`, which then refuses it) and it is worth
   * keeping in `activity_records.payload`, where it is a labelled smallest-units integer rather
   * than a decimal figure a feed would render — that is the distinction the column got wrong.
   */
  'wallet.withdrawal.requested': {
    payloadKeys: ['userId', 'amount', 'assetCode'],
    category: 'withdrawal',
    type: 'withdrawal.requested',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = money(event)
      const code = asset(event)
      if (value && code) return `Withdrawal of ${value} ${code} requested.`
      return code ? `A ${code} withdrawal was requested.` : 'A withdrawal was requested.'
    },
  },
  /* ── wallet's five, registered late, and every one of them keyed by something that is not a person ─
   *
   * `micro-wallet` emitted these five against a registry that carried three of its eight topics, so
   * `validateEnvelope` refused them and the relay set them aside — **244 rows on the mainnet
   * estate**, per the registry's own note. `micro-contracts` 5377269 registered them; this table
   * had no entry for any of them, which is what crashed `classify` (see `CLASSIFIER_TABLE`). The
   * structural repair above means a sixth would quarantine instead of throwing; these five are here
   * so they land somewhere a person can read rather than in the quarantine.
   *
   * **All five are `userFromPayload`, and that is the whole of the trap.** Four are keyed by a
   * `wallet_id` or a `withdrawal_id`, both `uuid` columns (`wallet/src/migrations.ts`), so
   * `userFromKey` does not fail on them — it returns a well-formed, queryable, WRONG id, exactly as
   * it did for `identity.session.created` in production. The fifth is keyed
   * `chain:network:address_key`, which is not a uuid at all. Every one of the five names the user on
   * its payload, and none may read the ACTOR: `wallet.link.revoked`'s actor is `input.by`
   * (`wallet/src/links.ts`), which is an OPERATOR when support disconnects a wallet, and
   * `deposit_address.assigned` and `withdrawal.stuck` are emitted by jobs as `service:wallet`.
   *
   * **No figure reaches any of these summaries, and that is measured rather than squeamish.**
   * wallet's `amount` is SMALLEST UNITS — `toWithdrawal` formats it as
   * `formatAmount(BigInt(row.amount), decimals)` (`wallet/src/withdrawals.ts`) and the
   * payload carries the raw side of that, with no `decimals` field to divide by. Same refusal as
   * `tessera.venue.booked` and `settlement.sweep.completed`, for the same measured reason — and
   * since #199 the refusal is `money`'s rather than each classifier's, so it covers the record's
   * `amount` COLUMN too. This block previously said the number was "still captured, typed, beside
   * its `assetCode`" in that column and treated that as safe; `hub-web/src/pages/activity.tsx`
   * renders it, so it was neither typed nor safe. The figure survives in the stored payload for
   * the topics that declare `amount`, which is where an unrendered field belongs.
   * ------------------------------------------------------------------------------------------ */
  /**
   * Where the user's money is supposed to be sent, and the topic 243 of those 244 rows were.
   *
   * `deposit`, not `wallet`: it is the first half of the deposit story whose second half is
   * `wallet.deposit.confirmed`, and a user reading "where did my deposit go" should find the
   * address they were given under the same filter as the credit that followed it. It is also the
   * record an operator needs for "which address did we give this person, and when" — the question
   * the registry's note says had nothing to read.
   *
   * `supersedesId` decides the sentence, and it is a real distinction rather than a nicety: an
   * address ASSIGNED is somewhere to send money to, an address ROTATED means the previous one
   * should not be used again (`wallet/src/deposits.ts`, `supersedes_id`). A user who reads the
   * two as one event keeps depositing to a superseded address.
   *
   * `walletId`, `assignmentId`, `scheme` and `custodyKeyUrn` are not declared. `custodyKeyUrn` is
   * the one that matters: it names the custody key the platform signs with, and it is not
   * something this service has any use for or any business keeping for ever.
   */
  'wallet.deposit_address.assigned': {
    payloadKeys: ['userId', 'assetCode', 'chain', 'network', 'address', 'supersedesId'],
    category: 'deposit',
    type: 'deposit.address_assigned',
    visibility: 'user',
    // Keyed `chain:network:address_key` (`wallet/src/deposits.ts`), which is not a user and not
    // a uuid; the payload names the user.
    userId: userFromPayload,
    summary: (event) => {
      // Every declared field is read before anything branches. The allowlist test drives this
      // function against a payload where every key is `undefined`, and a key read only inside a
      // taken branch would look undeclared-but-unread on the day the branch is not taken.
      const code = asset(event)
      const chain = text(event, 'chain', 24)
      const network = text(event, 'network', 24)
      const address = text(event, 'address', 64)
      const supersedes = payloadOf(event)['supersedesId']
      const what = code ? `${code} deposit address` : 'deposit address'
      const where = chain ? ` on ${chain}${network ? ` ${network}` : ''}` : ''
      const opening =
        typeof supersedes === 'string' && supersedes.length > 0
          ? `Your ${what}${where} was rotated. Use the new one from now on`
          : `A ${what} was assigned to you${where}`
      return address ? `${opening}: ${address}.` : `${opening}.`
    },
  },
  /**
   * A user proved they hold the key to an external wallet — which is what makes it a place money
   * may leave to.
   *
   * `wallet`, not `security`, and the argument is the one this file already made for putting
   * sign-IN and sign-OUT both under `security`: `wallet.wallet.created` files the linking of an
   * external wallet under `wallet`, so filing its verification and its revocation anywhere else
   * would mean the three events of one wallet's life cannot be read together under one filter.
   *
   * The address is in the sentence deliberately. The failure this event guards against is a link
   * the user did not make, and "an external wallet was verified" is not something anybody can check
   * — an address they can compare against the one they hold is.
   *
   * `scheme` and `authorisations` are not declared. `authorisations` is the permission list, which
   * the revocation event below reports on when it changes; holding a copy of it here would be a
   * second, ageing answer to a question the wallet service owns.
   */
  'wallet.link.verified': {
    payloadKeys: ['userId', 'chain', 'network', 'address'],
    category: 'wallet',
    type: 'wallet.link_verified',
    visibility: 'user',
    // NOT userFromKey: keyed by WALLET id (`wallet/src/links.ts`), a uuid. NOT userFromActor
    // either, though the actor happens to be `user:<userId>` here — see the header on
    // `userFromActor`; the payload states the owner, so nothing has to depend on that coincidence.
    userId: userFromPayload,
    summary: (event) => {
      const chain = text(event, 'chain', 24)
      const network = text(event, 'network', 24)
      const address = text(event, 'address', 64)
      const where = chain ? ` on ${chain}${network ? ` ${network}` : ''}` : ''
      const which = address ? ` (${address})` : ''
      return `You proved you hold the key to an external wallet${where}${which}. It can now be used as a withdrawal destination.`
    },
  },
  /**
   * The mirror of the above, and it is two facts rather than one.
   *
   * `wallet/src/links.ts` and §3.2: `authorisation: null` is "disconnect a wallet" — every
   * permission revoked AND the link itself closed, in one transaction — while a named
   * `authorisation` removes one permission and leaves the link standing. "This wallet is no longer
   * yours to withdraw to" and "this wallet may no longer do one particular thing" are not one entry
   * with a softer adjective, and `type` is a function for the same reason
   * `identity.session.revoked`'s is: the frontend switches on it to choose the emphasis.
   *
   * **Not `userFromActor`, and this is the topic that proves why the rule exists.** The actor is
   * `input.by`, which is whoever pressed the button — an operator revoking a compromised
   * link, or another service. The record belongs to the account holder either way, and reading the
   * actor here would file a support action in the support agent's feed and nowhere else.
   */
  'wallet.link.revoked': {
    payloadKeys: ['userId', 'authorisation', 'remaining'],
    category: 'wallet',
    type: (event) => (revokedWholeLink(event) ? 'wallet.link_revoked' : 'wallet.authorisation_revoked'),
    visibility: 'user',
    // Keyed by WALLET id (`wallet/src/links.ts`), a uuid; the payload names the user.
    userId: userFromPayload,
    summary: (event) => {
      const authorisation = text(event, 'authorisation', 32)
      const remaining = payloadOf(event)['remaining']
      const left = Array.isArray(remaining) ? remaining.length : null
      if (authorisation === null) {
        return 'An external wallet was disconnected from your account. It can no longer be used as a withdrawal destination.'
      }
      const rest =
        left === null
          ? ''
          : left === 0
            ? ' It has no permissions left.'
            : ` It has ${left} permission${left === 1 ? '' : 's'} left.`
      return `The "${authorisation}" permission was removed from an external wallet.${rest}`
    },
  },
  /**
   * **The user is owed this one**, in the registry's own words, and until now nobody was told.
   *
   * `settlement.outbound.failed` above says a failed withdrawal is currently in nobody's timeline,
   * because settlement's payload carries no `userId`. This is the other half of that sentence and
   * the half that can be delivered: `wallet/src/withdrawals.ts` emits `userId` off the row,
   * on the branch where the reservation has ALREADY been released back into the spendable balance
   * (, `deps.ledger.release`). The money is back before this event exists, so the entry is a
   * statement of fact rather than a promise.
   *
   * **`reason` is not declared, and that is a decision rather than an oversight.** It is
   * `refunded.failureReason`, which is written as `` `${err.code}: ${err.message}` ``
   * (`wallet/src/withdrawals.ts`) — an unbounded string from whatever failed, which on a chain
   * error routinely carries a destination address. That is a third party's identifier arriving in a
   * column this service keeps for ever, and `redact.ts`'s header is explicit that an over-declared
   * key is one that party's own erasure can never reach. The user does not need it and the operator
   * has it at the source.
   */
  'wallet.withdrawal.refunded': {
    payloadKeys: ['userId'],
    category: 'withdrawal',
    type: 'withdrawal.refunded',
    visibility: 'user',
    // NOT userFromKey: keyed by WITHDRAWAL id (`wallet/src/withdrawals.ts`), a uuid.
    userId: userFromPayload,
    summary: () =>
      'Your withdrawal could not be sent, and the amount that was held for it has been returned to your balance.',
  },
  /**
   * A DIFFERENT FACT from `settlement.withdrawal.stuck`, which is why both names stay.
   *
   * The registry carries both and they are not two spellings of one event:
   *
   *   * `settlement.withdrawal.stuck` — settlement's, keyed `chain:network`. An outbound
   *     transaction was BROADCAST and has not confirmed. Classified above as `withdrawal.stuck`,
   *     and it frequently has no user on it, which is why it is demoted to internal so often.
   *   * `wallet.withdrawal.stuck` — this one, wallet's, keyed `withdrawal_id`. A withdrawal sat in
   *     `queued` or `settling` past `WALLET_WITHDRAWAL_STUCK_MINUTES` with **no word from
   *     settlement at all** (`wallet/src/withdrawals.ts`). Nothing is known to have been
   *     broadcast; it may never have left. It always names the user, because `sweepStuck` selects
   *     `user_id` off the row.
   *
   * So the `type` differs too. Collapsing them onto `withdrawal.stuck` would hand the frontend one
   * icon for "we are waiting on a chain" and "we have lost track of your withdrawal", and would make
   * the operator query "which of these never got as far as a transaction" unanswerable from the
   * feed. `settlement.withdrawal.stuck` keeps the name it already has, in already-written rows.
   *
   * `user`-visible, and unlike settlement's it will actually stay that way. The money is reserved
   * and unspendable, and a balance a user cannot spend and cannot explain is named in wallet's own
   * comment as forge-pay's failure mode. The summary says the amount is still held, because the
   * one thing that must not happen is a user reading this and believing it has been returned —
   * `wallet.withdrawal.refunded` above is the event that means that, and it is a different entry.
   */
  'wallet.withdrawal.stuck': {
    payloadKeys: ['userId', 'stuckMinutes'],
    category: 'withdrawal',
    type: 'withdrawal.stuck_no_settlement',
    visibility: 'user',
    // NOT userFromKey: keyed by WITHDRAWAL id (`wallet/src/withdrawals.ts`), a uuid. NOT the
    // actor either — this is emitted by a sweep job as `service:wallet`.
    userId: userFromPayload,
    summary: (event) => {
      const minutes = payloadOf(event)['stuckMinutes']
      const waited =
        typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0
          ? ` for more than ${minutes} minutes`
          : ''
      return `Your withdrawal has had no word from settlement${waited} and is being investigated. The amount is still held, and has not been returned to your balance.`
    },
  },
  /**
   * The figure is settlement's `row.amount.toString()` — smallest units, and no formatted twin on
   * the payload (`settlement/src/withdrawals.ts`, `base(row)`). So the sentence names the
   * asset and the transaction and declines the number, which is the whole of what a user needs to
   * check it against their wallet anyway: the hash is the thing they can look up.
   *
   * The subject clause is a three-way rather than a two-way on purpose. "Your withdrawal was sent"
   * is the last resort, for an event with no asset code at all; with one it says which asset left,
   * because a user with a SHARD and an EMBER withdrawal in flight cannot tell two identical
   * sentences apart.
   */
  'settlement.withdrawal.completed': {
    payloadKeys: ['userId', 'amount', 'assetCode', 'transactionHash'],
    category: 'withdrawal',
    type: 'withdrawal.completed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const value = money(event)
      const code = asset(event)
      const hash = text(event, 'transactionHash', 66)
      const subject = value && code ? `${value} ${code}` : code ? `Your ${code} withdrawal` : 'Your withdrawal'
      return `${subject} was sent${hash ? ` in ${hash}` : ''}.`
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
   * the obvious reader. A withdrawal id is a `uuid` (`wallet/src/migrations.ts`) and a
   * sweep source id is a `uuid` too, so `userFromKey` does not return null on any of them — it
   * returns a real, well-formed, wrong id, and a wrong uuid queries exactly as cleanly as a right
   * one. That is `identity.session.created` twice over, which is the one mistake this file has
   * already made in production.
   *
   * `userFromPayload` is not automatically the repair either. `confirmedEvents`
   * (`settlement/src/withdrawals.ts`) and `failedEvents` build DELIBERATELY
   * NARROW payloads — `{ withdrawalId, txHash, confirmedAt }` and
   * `{ withdrawalId, reason, refundable }` — and neither carries `userId`. So for these two the
   * honest answer today is "no user is available", and the interesting question is what each of
   * them should do about it. They answer differently, and the difference is the whole point.
   * ------------------------------------------------------------------------------------------ */
  /**
   * **Nobody's feed, on purpose — because the user already has this entry.**
   *
   * This is not a case of "no user could be found and so we gave up". `confirmedEvents`
   * (`settlement/src/withdrawals.ts`) returns BOTH `settlement.outbound.confirmed` and
   * `settlement.withdrawal.completed` from a single `return [...]`, behind a single guard
   * (`row.purpose !== 'withdrawal' || !row.sourceRef`), for the same row. They are not two facts
   * that usually coincide; they are one fact emitted twice by one statement, and neither can occur
   * without the other. `settlement.withdrawal.completed` is classified sixteen lines above as
   * `withdrawal.completed`, `user`-visible, owner read off its payload's `userId` — which that
   * payload does carry (`withdrawals.ts`).
   *
   * Activity subscribes to every topic (AD-11), so it receives both. Attributing this one to a
   * user would therefore put "your withdrawal was sent" in that user's timeline TWICE for one
   * payment — which reads to the person holding the phone as two withdrawals, and is a worse feed
   * than a missing entry because it is a plausible one. wallet's subscription is the reason the
   * narrow topic exists at all (`wallet/src/settlement.ts`, branched on at
   * `wallet/src/server.ts` to release the reservation); the feed is not its audience.
   *
   * `() => null` rather than `userFromPayload`, and that choice is load-bearing rather than
   * decorative. `userFromPayload` returns null today too, so both spellings behave identically —
   * but the day settlement widens this payload (an entirely reasonable thing for it to do; the row
   * has `userId` right there at `outbound.ts`), `userFromPayload` would SILENTLY start
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
   * `wallet/src/withdrawals.ts` is where the difference is real rather than editorial:
   * `refundable === true` transitions the withdrawal to `failed` and then calls `refundWithdrawal`,
   * releasing the reservation back into the user's spendable balance; anything else transitions it
   * to **`stuck`** and returns — the funds stay held while an operator establishes whether the
   * payment left the platform. "Your money is coming back" and "your money is still held and
   * somebody is looking into it" are not one entry with a softer adjective. A single static `type`
   * would hand the frontend one icon for both, and `TopicClassifier.type` is a function precisely
   * so that `identity.session.revoked` would not have to do that.
   *
   * **The user, and the gap.** This topic carries no `userId` — `failedEvents`
   * (`settlement/src/withdrawals.ts`) emits `{ withdrawalId, reason, refundable }` and
   * nothing else — so `userFromPayload` finds nothing and `classify` files the record as internal.
   * That is stated rather than papered over, because unlike `.confirmed` above there is no second
   * topic covering this fact for the user: `failedEvents` returns a one-element array, no
   * `settlement.withdrawal.failed` exists in the registry, and the only other event in the
   * sequence is `wallet.withdrawal.refunded` (`wallet/src/withdrawals.ts`), which is
   * unregistered, fires only on the refundable branch, and so cannot cover the stuck one at all.
   * **A failed withdrawal is currently in nobody's timeline.** A classifier may not read a
   * database, so this repository cannot close that; the repair is one field on settlement's
   * payload — `userId: row.userId`, which `stuckEvents` already puts on the neighbouring event
   * (`withdrawals.ts`) from the same row — and it is filed for micro-settlement.
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
    // NOT userFromKey: the key is the WITHDRAWAL id (`withdrawals.ts`, registry keyedBy
    // `withdrawal_id`) and it is a uuid (`wallet/src/migrations.ts`), so userFromKey would
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
   * 1. There is no user on the event. The payload (`sweeps.ts`) is
   *    `{ outboundId, sweepSourceId, chain, network, assetCode, from, to, amount, fee, txHash,
   *    confirmedAt }`. The owner exists but only in a table: `sweep_sources.custody_user_id`,
   *    which settlement itself has to go and read (`sweepBindingFor`, `sweeps.ts`). A
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
   * (`settlement/src/withdrawals.ts`, `chains.ts`), the payload does not say how many
   * decimals the asset has, and a rendered figure that is off by eighteen orders of magnitude is
   * worse for the operator reading it than no figure at all.
   *
   * **This block used to end "`assetCode` and `amount` still reach the record's own columns
   * through `classify`, where they are typed and not prose", and that second half was wrong.**
   * `hub-web/src/pages/activity.tsx` prints `formatAmount(record.amount)` next to
   * `record.assetCode`, so the column is rendered as money one hop later — the argument written
   * here to keep the figure out of the prose applies to it unchanged. `assetCode` still reaches
   * its column; the figure is kept in the stored payload, in its own units. `money` has the full
   * reasoning and now applies it to every topic rather than to the ones somebody remembered.
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
    // An operator act on the platform, no player subject (`worlds/src/titles.ts`).
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
    // Keyed by REWARD id; the user is in the payload (`worlds/src/rewards.ts`).
    userId: userFromPayload,
    // `amountShards` is worlds' spelling of the figure (`worlds/src/rewards.ts:564`) and the only
    // asset-ish thing on the payload. `seasonRewardSummary` has the whole argument for why a
    // field NAME saying shards does not put "Shards" in a sentence a player reads.
    summary: (event) => seasonRewardSummary(event, 'amountShards'),
  },
  'worlds.provision.completed': {
    payloadKeys: ['subject'],
    category: 'ownership',
    type: 'worlds.provision_completed',
    visibility: 'user',
    // Keyed by ENTITLEMENT id; the user is the provision `subject`
    // (`worlds/src/provisioning.ts`), and the actor is the service — the actor fallback
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
    // Same subject reader (`worlds/src/provisioning.ts`): the person who paid must see
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
    // Keyed `user:code`, NOT a bare uuid (`emberkin/src/battles.ts`) — userFromKey would
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
    // Keyed by BATTLE id; user in the payload (`emberkin/src/battles.ts`).
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
    // Keyed by idempotency key; user in the payload (`emberkin/src/seasons.ts`).
    userId: userFromPayload,
    // The same function as worlds' rule, on emberkin's spelling of the figure
    // (`emberkin/src/seasons.ts:139`). The two rules saying different things about the same
    // event is half of what micro-org #227 reports about this pair.
    summary: (event) => seasonRewardSummary(event, 'amount'),
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
    // Keyed by CITY id; the user is in the payload (aetherholm/src/cities.ts). The session
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
    // (aetherholm/src/provisioning.ts).
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
    // aetherholm/src/fleets.ts), and the payload carries attackerUserId AND defenderUserId.
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
    // (aetherholm/src/sealing.ts); an alliance holds as a group, in which case there is no
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
   * **LIVE, and it was dead for most of this file's history.** The gap this comment used to record
   * — "mint declares five other names and `mint.deploy.confirmed` is not among them" — is closed:
   * `mint/src/tokens.ts` now exports it as `DEPLOYED_TOPIC` and `mint/src/topics.ts` lists it in
   * `EMITTED_TOPICS`, so the one fact the estate agreed to send is the name mint uses. Re-verified
   * against `mint/src` rather than taken on trust, which is how the original gap was found.
   *
   * The two entries beside it that the same check named — `custody.key.exported` and
   * `settlement.withdrawal.stuck` — were repaired by their own repositories first
   * (`custody/src/exports.ts`, `settlement/src/withdrawals.ts`). All of them are now live.
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
  /**
   * The platform paying for its own deploy, which is why it is `internal` beside a `user` sibling.
   *
   * A paid order derives a fresh deployer address that holds nothing, and mint asks settlement to
   * top it up out of the treasury. The customer's token still deploys and `mint.deploy.confirmed`
   * above is what they hear about; this is the estate's own plumbing, and an entry reading "we
   * moved our money into our own address" in a person's feed would be noise attached to a fact
   * they cannot act on. It belongs where an operator reads it — the same argument that files
   * `settlement.sweep.completed` internally.
   *
   * **`userId` is `() => null` and the key is the trap it avoids.** The registry keys this topic by
   * `token_id`, which is a uuid, so `userFromKey` would file every one of these under a "user" that
   * is really a token row: well-formed, queryable, and wrong. The payload carries no `userId` at
   * all, deliberately — mint's own header says the platform topping up its own deployer is not a
   * fact about the customer.
   *
   * The summary carries no amount. `amountWei` is smallest units and the payload does not say how
   * many decimals the chain has, so `money` declines it and the figure stays in the stored payload
   * in its own units, where a reader who needs it knows what they are looking at.
   */
  'mint.deploy.funding_requested': {
    payloadKeys: ['chain', 'network'],
    category: 'token',
    type: 'token.deploy_funding_requested',
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const chain = text(event, 'chain', 24)
      const network = text(event, 'network', 24)
      const where = chain ? ` on ${chain}${network ? ` ${network}` : ''}` : ''
      return `A paid deploy asked the treasury for gas${where}.`
    },
  },
  'market.listing.sold': {
    payloadKeys: ['userId', 'price', 'assetCode'],
    category: 'market',
    type: 'market.listing_sold',
    visibility: 'user',
    userId: userFromPayload,
    // `orders.amount` is `numeric(78,0)` (`market/src/migrations.ts`), so market is a
    // smallest-units producer and `money` declines the figure. It declined it before this change
    // too, for a different reason worth keeping written down: `orderEventPayload` emits `amount`
    // and not `price` (`market/src/orders.ts`), so this reader has never matched a field
    // market sends. That is micro-market's or this table's to reconcile, and it is not a scale bug.
    summary: (event) => {
      const value = money(event, 'price')
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
   * argument beside it (`market/src/bids.ts`): "a notification sent to the wrong person
   * about someone else's money is worse than no notification". `notify` had declined to write a
   * rule at all while the field was missing. This classifier reads that field and no other.
   *
   * A SUBJECT, not a bare uuid — a listing may be owned by a service principal
   * (`market/src/server.ts` takes the seller from `subjectOf(principal)`), and
   * `userFromSubjectField` returns null for `service:<name>` rather than filing a machine's sale
   * in a person's feed. A null owner is made `internal` by `classify` below.
   *
   * `amount` and `assetCode` are declared because the payload spells them with those exact names.
   * `assetCode` reaches the record's column; `amount` does not, and `money` says why — `bids.amount`
   * is `numeric(78,0)` (`market/src/migrations.ts`), so the figure on this payload is a count
   * of indivisible units and there is no `decimals` here to divide it by. It is kept in the stored
   * payload, in its own units, rather than rendered beside a code as though it were a price.
   */
  'market.offer.made': {
    payloadKeys: ['sellerSubject', 'amount', 'assetCode'],
    category: 'market',
    type: 'market.offer_made',
    visibility: 'user',
    userId: userFromSubjectField('sellerSubject'),
    summary: (event) => {
      const value = money(event)
      const code = asset(event)
      if (value && code) return `Someone offered ${value} ${code} on your listing.`
      return code ? `Someone made a ${code} offer on your listing.` : 'Someone made an offer on your listing.'
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
    // The emit (`community/src/jobs.ts`) is a scheduled transition run by
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
  /* ── the topics whose PAYLOADS NAME NOBODY: trade's four and devplatform's two ──────────────
   *
   * Three of these arrived together by micro-contracts `8889373`. Three more joined them with
   * micro-org#345 — `trade.bot.created`, `trade.bot.started` and `trade.fee.settled`, all three
   * emitted with an actor of `user:` plus the bot's own `userId` column, read off the bot row, and
   * a payload that names the BOT and not its owner. The block below carries the rest of #345's
   * argument; this header is the part the six share.
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
   *   - `trade/src/bots.ts`, the sole `trade.bot.paused` emit, sends `{ botId }`.
   *   - `devplatform/src/apikeys.ts`, `emitKeyIssued`, sends
   *     `{ keyId, projectId, environment, display, scopes }`.
   *   - `devplatform/src/apikeys.ts`, `emitKeyRevoked`, sends
   *     `{ keyId, projectId, environment, display, lookupId, reason }`.
   *
   * The owner is on the ENVELOPE, in `actor`, and only reading it there gets these three into the
   * right feed. See `userFromActor` for why that reader is quarantined to exactly these topics and
   * what it costs when it is used anywhere else. `notify` reached the same conclusion from the
   * same payloads for its two API-key rules, independently and first.
   * ------------------------------------------------------------------------------------------ */
  /**
   * A bot exists. **No money has moved and the summary must not imply that it has.**
   *
   * `insertBot` writes the row and mirrors the allocation the user typed into the bot's own `cash`
   * and `equity`; the ledger is not called until the bot is STARTED, and even then only for a live
   * one. So this is the record of an intention, and the entry below it is the record of the money.
   *
   * **`mode` is the whole of the news.** `BotMode = 'paper' | 'live'` (`trade/src/bots.ts`), and a
   * paper bot never touches the journal at all — `runBot`'s paper branch says so at the fill
   * ("posting it would put a simulation in the journal"). "You created a trading bot" without that
   * word is the one sentence here that a reader could act wrongly on, in either direction: believing
   * a simulation is spending their balance, or believing a live bot is not.
   *
   * **`allocation` is read by nothing and therefore declared by nothing.** It is a Shard count, and
   * Shards are an integer currency with no sub-unit (`trade/src/money.ts`), so `money` declines it
   * for the reason every smallest-units producer's figure is declined — and it is SHARD-denominated,
   * which `RETIRED_ASSETS` would refuse to name to a user anyway (micro-org #227). The producer's
   * own figure survives verbatim in `activity_records.payload`… except that it does not, because an
   * undeclared key is dropped: it appears in `__redacted` instead. That is the allowlist working as
   * designed and it is stated here so the next reader does not think it an oversight.
   */
  'trade.bot.created': {
    payloadKeys: ['mode', 'strategyId'],
    category: 'trading',
    type: 'trading.bot_created',
    visibility: 'user',
    // The actor is the OWNER off the bot row, not whoever called the route — same as the pause
    // below. NOT userFromKey: the key is `bot.id` (registry `keyedBy: 'bot_id'`), a uuid.
    userId: userFromActor,
    summary: (event) => {
      const strategy = text(event, 'strategyId', 32)
      const named = strategy ? ` running ${strategy}` : ''
      return text(event, 'mode', 8) === 'paper'
        ? `A paper trading bot${named} was created. It trades simulated money and cannot move your balance.`
        : `A live trading bot${named} was created. Starting it will reserve its allocation from your balance.`
    },
  },
  /**
   * **THE MOMENT THE PLATFORM TAKES A CUSTOMER'S CAPITAL AND HOLDS IT** — for a live bot.
   *
   * `startBot` calls the ledger's `reserve` as `service:trade` BEFORE the status changes, and the
   * schema refuses a running live bot without a reservation (`bots_live_capital_reserved`). That
   * reservation is the fact this entry exists for, and it is why `contracts`' audit table decides
   * yes here and no on the creation above.
   *
   * **Two facts, and `reservationId` is the discriminator that already exists on the payload.** A
   * paper start reserves nothing — `startBot` only enters the reserve branch for `mode === 'live'`
   * — so the field is null on exactly the events where no money moved. Reading `reservationId`
   * rather than `mode` is deliberate: `mode` says what the bot IS, and this branch needs to say
   * what this START DID. A live bot restarted after a pause already holds its reservation and takes
   * the same branch, correctly, because the capital is still held.
   *
   * The summary says the allocation is not spendable elsewhere, which is the part a reader cannot
   * see anywhere else: a reservation moves nothing between accounts, so a balance that looks
   * unchanged is nonetheless smaller than it was.
   */
  'trade.bot.started': {
    payloadKeys: ['reservationId'],
    category: 'trading',
    type: (event) =>
      typeof payloadOf(event)['reservationId'] === 'string'
        ? 'trading.bot_started'
        : 'trading.bot_started_paper',
    visibility: 'user',
    userId: userFromActor,
    summary: (event) =>
      typeof payloadOf(event)['reservationId'] === 'string'
        ? 'Your trading bot started. Its allocation is now reserved: the balance is still yours, but it cannot be spent elsewhere until the bot stops.'
        : 'Your paper trading bot started. It trades simulated money and cannot move your balance.',
  },
  /**
   * The first record written into the `trading` category, and for a long time the only one — the
   * two entries above it and the four below arrived with micro-org#345.
   *
   * **One fact, not two.** A pause is a pause: `pauseBot` (`trade/src/bots.ts`) has one
   * caller (`trade/src/server.ts`), one guard (`bot.status !== 'running'`) and one payload, and
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
    // The actor is the bot's OWNER and not the caller: `bots.ts` writes
    // `actor: \`user:${bot.userId}\`` off the row, so it names the owner whoever pressed the
    // button. NOT userFromKey — the key is `bot.id` (registry `keyedBy: 'bot_id'`), a uuid, so a
    // key reader would file every pause against a bot id dressed as a person.
    userId: userFromActor,
    summary: () =>
      'Your trading bot stopped. Pausing does not close its position — that stays open until you resume or stop the bot.',
  },
  /* ── trade's FOUR MONEY TOPICS. micro-org#345 ───────────────────────────────────────────────
   *
   * Every one of these four corresponds to a ledger entry, and all four spent the life of the
   * service in `unclassified` — which cost more than the missing feed rows. `unclassified` maps to
   * the `quarantine` retention class, 90 days, while a `trading` or `transfer` record is
   * `financial` at 1825. Four topics' worth of money movement was being deleted at three months
   * because nobody had written a classifier, and the pruner was doing exactly what it was told.
   *
   * **`trade` joins `SMALLEST_UNIT_PRODUCERS` in the same change, and that is load-bearing.** Every
   * figure on these four payloads is an integer count: `trade/src/money.ts` is `bigint` throughout
   * with a header that names the float-money defect it exists to close, and every money column in
   * `trade/src/migrations.ts` is `numeric(78,0)`. Without that line, `money` would put a raw Shard
   * count in the `amount` column and `hub-web`'s decimal formatter would render it with thousands
   * separators as if it were a decimal figure. See `money`'s own header — the column is prose with
   * extra steps.
   *
   * The consequence is that NONE of the four prints a figure today, and the summaries are written
   * to be worth reading without one. Each of them carries what the reader cannot get elsewhere: an
   * asset code, a direction, a market, or the fact that the platform charged them.
   * ------------------------------------------------------------------------------------------ */
  /**
   * **EMITTED SINCE micro-trade `ee5e189`, and this classifier predates the emit deliberately.**
   *
   * What stood here until that landed was the measurement rather than a complaint: `applyFill` and
   * `settleFill` each took an OPTIONAL `emit`, neither of `tickBot`'s two call sites — the paper
   * branch and the live one — ever passed one, and zero `trade.fill.settled` had reached this
   * service or the mainnet `trade.outbox` in the life of the service. The classifier was written
   * against a topic nothing sent on the argument that a classifier for a topic no producer sends is
   * the same defect as a producer no classifier covers, and only the second has a compile error to
   * announce it. That bet paid: the emit was wired up in trade with no edit needed on this side, so
   * the first fill this service ever sees will be classified rather than quarantined. It has not
   * seen one yet — `activity_records` holds zero rows on ANY `trade.%` topic on either network,
   * counted 2026-08-12 — which is the state this classifier was always written for.
   *
   * trade closed it by making the argument REQUIRED rather than by passing the optional one, so a
   * third call site that forgets it is a compile error in trade instead of another silence here.
   * Both branches of `tickBot` publish, including the paper one — see the `entryId` note below,
   * which is the reason a simulated fill is worth a record at all.
   *
   * **`userFromPayload` and `payloadKeys: ['userId', …]` are LIVE readers now, not aspirational
   * ones.** They were written against a payload that did not carry the field — `FillRecord.userId`
   * existed on the row `applyFill` returns and `settleFill` already passed it to `fillPostings`,
   * but nothing put it on the wire — so every fill would have been demoted to `internal` by
   * `classify`'s own owner check, which is the right answer when a classifier cannot find an owner
   * and may not query a database to look one up. `ee5e189` put `userId` on the payload. The fills
   * are `user`-visible records in their owner's feed from that commit forward, and the branch that
   * used to be dead is the one that runs.
   *
   * **The envelope now names an actor too, and this reader still takes the PAYLOAD.** The emit
   * passes `user:${fill.userId}` off the same row it reads `userId` from, so the two agree by
   * construction and neither is a guess — but the payload is the reader that needs no citation, and
   * `userFromActor` is quarantined to the six topics whose payload names nobody (see its header).
   * Switching this entry to the actor would widen that set for no gain and would put a fill in
   * whoever's feed a future emit decides to blame.
   */
  'trade.fill.settled': {
    payloadKeys: ['userId', 'side', 'entryId'],
    category: 'trading',
    type: 'trading.fill_settled',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const side = text(event, 'side', 8)
      const traded = side === 'buy' ? 'bought' : side === 'sell' ? 'sold' : 'traded'
      // `entryId` is null for a paper fill and a journal id for a live one — `tickBot`'s paper
      // branch makes no ledger call, because "posting it would put a simulation in the journal".
      // So the presence of the entry is the only thing on this payload that separates imaginary
      // money from real money, and a summary that did not say so would describe both identically.
      //
      // This discriminator did not lose its job when the emit was wired up; it GAINED one. trade
      // publishes from the paper branch too, and says so on purpose, citing this line: the outbox
      // is not the journal, and a simulated fill is a thing its owner asked for and should be able
      // to see happening. Both branches therefore arrive on this topic, and the null entry is the
      // only field that tells them apart — collapse it and every paper fill claims to have moved
      // the reader's balance.
      return typeof payloadOf(event)['entryId'] === 'string'
        ? `Your trading bot ${traded} and the fill settled against your balance.`
        : `Your paper trading bot ${traded}. No real money moved.`
    },
  },
  /**
   * **THE PLATFORM CHARGING THE CUSTOMER**, which is the one entry in this block whose absence a
   * user would have noticed. A performance fee leaves an account on the estate's own initiative
   * rather than the customer's, and "why was I billed this" is answerable from the settlement, the
   * period and the journal entry, or it is not answerable at all. `contracts`' audit table decides
   * yes here for the same sentence.
   *
   * **Neither figure can be shown and the summary does not pretend otherwise.** `collected` and
   * `due` are cent counts — smallest units, so `money` declines both — and neither is spelled
   * `amount`, so neither reaches the `amount` column either. Everything below is therefore written
   * to carry the FACT without the number, which is the constraint the whole of trade's block works
   * under and the reason `status` rather than `due - collected` is what this entry reads.
   *
   * **Two facts, and `status` is the discriminator — as of micro-trade `ee5e189`.** What stood here
   * was the opposite claim, and it was true when it was written: the payload was
   * `{ settlementId, botId, period, collected, entryId }`, `status` was a column on trade's own row
   * and on nothing that crossed the wire, and a wallet that covered a twentieth of the fee produced
   * a byte-identical event to one that covered all of it. This rule and notify's wrote that limit
   * down against themselves on 2026-08-10 rather than hedging the copy — "a sentence that says
   * 'some or all of a fee' is worse than one that says a fee was charged" — and trade sent `status`
   * and `due` instead, which is the repair those two notes were asking for.
   *
   * A partial collection is not a smaller version of the same news. The customer's balance did not
   * cover the assessment, `settleFee` writes the shortfall back to `feeOwed`, and the next period's
   * `due` is `fee + feeOwed` — so the money is still owed and will be taken. A reader told "a
   * performance fee was charged" has been told the matter is closed when it is not, and will next
   * see a settlement that takes more than one period's fee with nothing in the feed explaining why.
   * That is why this gets a `type` of its own and not just a second sentence: `type` is what a
   * frontend switches an icon and an emphasis on, and the two entries above (`trade.bot.started`'s
   * reservation and `trade.order.filled`'s side) split on exactly this test — a field of the
   * payload separating two messages a reader must not confuse. `devplatform.key.issued` refuses the
   * split for the complementary reason, that its distinction is already carried by `visibility`;
   * nothing else on this record carries the difference between a fee taken and a fee half taken.
   *
   * **`uncollectable` cannot arrive here and the code must not pretend it can.** `settleFee` emits
   * inside `if (collected > 0n)` and that guard deliberately stayed: an uncollectable settlement
   * moved no money at all, and publishing it on a topic whose consumers render a charge would be a
   * charge that did not happen. So the branch below is binary by construction, and the fallback is
   * the charged sentence rather than a third one — a status this producer cannot send is not worth
   * a message no user can ever be shown. A bot in arrears having no event of its own is a real gap
   * and it is trade's to close with a topic of its own, filed on micro-org#367.
   */
  'trade.fee.settled': {
    payloadKeys: ['period', 'status'],
    category: 'trading',
    type: (event) =>
      text(event, 'status', 16) === 'partial' ? 'trading.fee_settled_partial' : 'trading.fee_settled',
    visibility: 'user',
    // The actor is the bot's OWNER off the row (`settleFee`), exactly as the pause and the two
    // bot-lifecycle entries above. NOT userFromKey: the key is the SETTLEMENT id (registry
    // `keyedBy: 'settlement_id'`), a uuid that is not a person.
    userId: userFromActor,
    summary: (event) => {
      // The period counter, not a date: trade numbers a bot's settlement periods from its start.
      // It is the handle a support conversation needs — "the fee for period 4" — and it is the
      // only field on this payload that is neither an opaque id nor a figure that cannot be shown.
      const period = amount(event, 'period')
      const which = period === null ? '' : ` for period ${period}`
      // No figure in either sentence, and that is not squeamishness: `collected` and `due` are cent
      // counts, `money` declines them for the reason its header gives, and a template that printed
      // one would render $12.50 as 1250. The partial sentence therefore says the balance fell short
      // and that the rest is still owed, which is what a reader can act on, and leaves the amount to
      // the settlement screen that can look up the scale.
      return text(event, 'status', 16) === 'partial'
        ? `Only part of the performance fee on your trading bot was collected${which} — your balance did not cover it. The rest stays owed and comes out of the next settlement.`
        : `A performance fee was charged on your trading bot${which}. It is taken from the gain above the bot's previous high-water mark.`
    },
  },
  /**
   * The exchange's own order book, and the only topic in this block that names its user outright.
   *
   * **`userFromPayload`, not the actor.** `matchOrder` emits with no actor, so the envelope says
   * `service:trade` — but the payload carries `userId`, and it is the TAKER's: the order that
   * crossed. The maker on the other side of every fill gets no record from this event and cannot,
   * because a classifier returns one record and may not read a database to find the counterparty.
   * The same limit as `market.listing.sold` and `tessera.parcel.transferred`, and stated here for
   * the same reason: a reader looking for the maker's row should find out why it is absent from
   * this file rather than from an empty query.
   *
   * **Two facts, and the side is the discriminator.** Buying and selling are not one entry with a
   * different noun in it — a frontend chooses an icon and a colour from `type`, and a feed that
   * rendered a sale as a purchase is a feed people stop believing. Same argument as
   * `identity.session.revoked`'s.
   *
   * **`filledQty` and `filledQuoteQty` are base units and are not read.** They are the asset's
   * indivisible units, so their scale depends on `chainSpec(asset).decimals`, which this service
   * cannot call; `money` would decline them even if they were spelled `amount`. The symbol and the
   * side are what the reader can act on, and the terminal shows the figures live.
   *
   * **Behind `TRADE_EXCHANGE_ENABLED` today.** Classified anyway, and for the reason the registry
   * entry gives: the day the flag goes on is the worst day to discover this file has no opinion.
   */
  'trade.order.filled': {
    payloadKeys: ['userId', 'symbol', 'side'],
    category: 'trading',
    type: (event) => (text(event, 'side', 8) === 'sell' ? 'trading.order_sold' : 'trading.order_bought'),
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      // `symbol` is a market name (`EMBER/USD`) written by trade's own market table, not by a
      // user — but it is capped anyway, because a summary is rendered in a feed and "the producer
      // validates it" is a claim about today's producer.
      const symbol = text(event, 'symbol', 24)
      const market = symbol ? ` on ${symbol}` : ''
      return text(event, 'side', 8) === 'sell'
        ? `Your sell order${market} filled.`
        : `Your buy order${market} filled.`
    },
  },
  /**
   * Money crossing the boundary between a customer's wallet and their exchange balance.
   *
   * **`transfer`, not `trading`.** The sixteen categories are what a user's feed is FILTERED by,
   * and somebody looking for "where did my EMBER go" filters on movements, not on trading
   * activity. `ledger.entry.posted` is filed the same way for the same reason, and this is the
   * event that says which side of the boundary the money went to.
   *
   * **Two facts, and `direction` is the discriminator the producer already sends.** A deposit into
   * the exchange and a withdrawal back out of it are opposite movements; one static type would hand
   * a frontend one arrow for both.
   *
   * **The asset is named and the figure is not, and that asymmetry is the point.** `amount` is base
   * units of the asset — `settleTransfer` writes `transfer.amount.toString()` off a `numeric(78,0)`
   * column — so `money` declines it now that `trade` is a smallest-units producer. The code is read
   * into the SUMMARY, where "your EMBER deposit settled" is a sentence and "a transfer settled" is
   * not, and into the `asset_code` COLUMN, which is what a feed filtered or grouped by asset reads.
   *
   * **The column was null on every one of these rows until micro-trade `fix/transfer-asset-code`,
   * and the argument that used to stand here is the reason it was.** trade spelled the field
   * `asset` while every other asset-bearing topic on the estate spells it `assetCode`; `classify`
   * fills the column from `assetCode` alone, so the code reached the prose and nothing else. This
   * file declined to invent a second spelling for the column and wrote the defect down instead —
   * correctly, because a classifier that quietly accepted `asset` would have made the producer's
   * inconsistency permanent and invisible, and a second reader is the thing the next author copies.
   * The producer was the wrong half and the producer is what changed. The declaration and the
   * reader below are now the ordinary ones, spelled the same as `wallet.deposit.confirmed`'s and
   * `market.listing.sold`'s, and `asset_code` is populated for exchange transfers from the commit
   * that renames the field forward.
   *
   * **Nothing to migrate, and that was measured on both sides rather than assumed.** trade's
   * mainnet `exchange_transfers` holds zero rows and `TRADE_EXCHANGE_ENABLED` is set on neither
   * network, so no event was ever emitted under the old spelling; and this service's own
   * `activity_records` — mainnet 18,907 rows, testnet 10,257 — holds zero rows on ANY `trade.%`
   * topic, so there is no stored row whose `asset_code` a backfill could fill in. Both counted
   * 2026-08-12. The window in which this rename costs nothing is the one it was made in, which is
   * also why reading the old spelling as a fallback would be worse than useless: it would keep a
   * dead branch alive to cover a case that never happened.
   */
  'trade.transfer.settled': {
    payloadKeys: ['userId', 'assetCode', 'direction'],
    category: 'transfer',
    type: (event) =>
      text(event, 'direction', 16) === 'withdrawal'
        ? 'transfer.exchange_withdrawal'
        : 'transfer.exchange_deposit',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      // `asset()`'s default field, which is `assetCode` — the same reader, on the same key, that
      // `classify` fills the column from. One spelling and one validator: a code the column would
      // refuse is not printed in the prose either, and the two cannot drift apart.
      const code = asset(event)
      const named = code ? `${code} ` : ''
      return text(event, 'direction', 16) === 'withdrawal'
        ? `Your ${named}withdrawal from the exchange settled and is back in your wallet balance.`
        : `Your ${named}deposit into the exchange settled and is available to trade.`
    },
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
    // `devplatform/src/server.ts`, in the key-issuing route, passes `actorOf(caller)` — which
    // is `user:<id>` for a session-holding caller (`actorOf`, `server.ts`).
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
   *   - `devplatform/src/server.ts`, the key-revocation route — the owner's own `DELETE`,
   *     actor `actorOf(caller)`. The news is a receipt: an integration the reader deliberately
   *     broke.
   *   - `devplatform/src/server.ts`, in the `identity.organisation.deleted` handler, which
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
    // NOT userFromKey: `apikeys.ts` passes `key.id` (registry `keyedBy: 'key_id'`), a uuid.
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
   * `notify` says it plainly (`catalogue.ts`): a contest is only insertable after 90 days
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
   * grounds to overrule (`catalogue.ts`): a contest "takes ground off its owner while
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
  /* ── agora — the square. Fourteen topics, one attribution rule, and two refusals ─────────────
   *
   * **Every one of these reads `payload.subject`, and none reads the envelope actor.** agora emits
   * `actor: subject` on almost all fourteen, so `userFromActor` would work today and would be the
   * wrong instrument: the actor is who acted, and half of this producer's events are acts performed
   * ON somebody. `agora.voice.suspended` is the standing proof — its actor is the OPERATOR — and a
   * classifier that reached for the actor because the payload looked thin would file a suspension
   * in the moderator's timeline instead of the suspended person's. agora names the person on the
   * payload precisely so that no consumer has to make that judgement; see its emit sites, which say
   * so in those words.
   *
   * **A voice id is not a user id.** `voiceId`, `authorId`, `followeeId`, `barredId` and
   * `createdBy` are all agora's own identifiers for a person and mean nothing to this service or to
   * `activity_records.user_id`; writing one there would produce a row no feed query can ever match.
   * That is why every entry below reads `subject` and none of them reads a voice.
   *
   * **The second party is never named.** A follow, a bar and a spark all involve two people, and
   * only the actor's record is written here — the other party learns of it from agora's own
   * notifications, which is where a fact about a stranger's account belongs. So `followeeId`,
   * `barredId` and `authorId` are undeclared and dropped at ingest, not stored "in case".
   *
   * **Two topics are owned by nobody, deliberately.** `agora.report.filed` never names its
   * reporter — agora refuses to put it on the bus, so nothing can be attributed — and
   * `agora.whisper.sent` carries no subject either, because "who messaged whom, and when" is the
   * metadata of a private conversation and a second service holding it is exactly the copy the
   * whole design avoids. Both are `internal` with a null owner: the event is still recorded, which
   * is the difference between a fact nobody owns and a fact nobody kept.
   *
   * No body, no handle of anybody else, and no post text reaches a summary here, because none of it
   * reaches the bus in the first place.
   */
  'agora.post.created': {
    payloadKeys: ['subject', 'kind'],
    category: 'community',
    type: 'agora.post_created',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    summary: (event) => {
      // `kind` is agora's own three-way (`agora/src/posts.ts`): a reply, a quote, or a post.
      const kind = text(event, 'kind', 16)
      if (kind === 'reply') return 'You replied in the square.'
      if (kind === 'quote') return 'You quoted a post.'
      return 'You published a post.'
    },
  },
  'agora.post.edited': {
    payloadKeys: ['subject'],
    category: 'community',
    type: 'agora.post_edited',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    // Neither the old words nor the new are on the bus, so neither is in this sentence.
    summary: () => 'You edited a post.',
  },
  'agora.post.deleted': {
    payloadKeys: ['subject'],
    category: 'community',
    type: 'agora.post_deleted',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    summary: () => 'You deleted a post.',
  },
  'agora.spark.created': {
    payloadKeys: ['subject'],
    category: 'community',
    type: 'agora.spark_created',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    // The AUTHOR's half of this — "somebody sparked your post" — is agora's own notification and
    // is not duplicated here. This record is the sparker's own act, which is what a personal
    // timeline is for, and `authorId` stays undeclared rather than filed under somebody's feed.
    summary: () => 'You sparked a post.',
  },
  'agora.echo.created': {
    payloadKeys: ['subject'],
    category: 'community',
    type: 'agora.echo_created',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    summary: () => 'You echoed a post.',
  },
  'agora.voice.renamed': {
    payloadKeys: ['subject', 'from', 'to'],
    category: 'community',
    type: 'agora.voice_renamed',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    summary: (event) => {
      // Both read unconditionally: a rename whose event lost one half still gets a true sentence,
      // and a conditional read would declare a key this classifier cannot prove it uses.
      const from = text(event, 'from', 32)
      const to = text(event, 'to', 32)
      if (from && to) return `You changed your handle from @${from} to @${to}.`
      return to ? `You changed your handle to @${to}.` : 'You changed your handle.'
    },
  },
  /**
   * The SUSPENDED person's record, and the reason this whole block refuses `userFromActor`.
   *
   * The actor on this envelope is the operator (`agora/src/moderation.ts`), so the one topic here
   * whose actor is not its subject is also the one whose news is most consequential to get right.
   * agora returns `subject` from the row it is already updating for exactly this reader.
   *
   * `community` rather than `security`: a login is untouched, and the account is not disabled.
   * What is withdrawn is the right to post in the square, which is a fact about the square.
   */
  'agora.voice.suspended': {
    payloadKeys: ['subject', 'reason'],
    category: 'community',
    type: 'agora.voice_suspended',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    summary: (event) => {
      // Operator-entered prose, so it is capped like every other free-text field that reaches a
      // rendered summary.
      const reason = text(event, 'reason', 96)
      return reason
        ? `Your ability to post in the square was suspended: ${reason}`
        : 'Your ability to post in the square was suspended.'
    },
  },
  'agora.follow.created': {
    payloadKeys: ['subject', 'state'],
    category: 'community',
    type: 'agora.follow_created',
    visibility: 'user',
    // The FOLLOWER's, which is whose act it is. agora puts the follower's subject on the payload
    // and leaves the followee a voice id, so this reader cannot accidentally become the other one.
    userId: userFromSubjectField('subject'),
    summary: (event) => {
      // A locked voice's follow is pending until approved, and the two are different facts — the
      // registry's description says so, and a feed that called both "followed" would tell someone
      // they are following an account that has not let them in.
      const state = text(event, 'state', 16)
      return state === 'pending' ? 'You asked to follow a voice.' : 'You followed a voice.'
    },
  },
  'agora.bar.created': {
    payloadKeys: ['subject'],
    category: 'community',
    type: 'agora.bar_created',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    // `barredId` is undeclared on purpose. A bar is symmetric and total inside agora, but a second
    // service holding "this account blocked that one" is a fact about two people, one of whom
    // never agreed to it and cannot see this record.
    summary: () => 'You barred a voice.',
  },
  'agora.circle.created': {
    payloadKeys: ['subject', 'name'],
    category: 'community',
    type: 'agora.circle_created',
    visibility: 'user',
    userId: userFromSubjectField('subject'),
    summary: (event) => {
      const name = text(event, 'name', 48)
      return name ? `You opened the circle ${name}.` : 'You opened a circle.'
    },
  },
  /**
   * NOBODY'S FEED, and this is the entry to read before adding a fifteenth.
   *
   * The payload is a thread id, two voice ids and a character count — no subject, because agora
   * refuses to put one there. What could be reconstructed from a stream of these is who talks to
   * whom and how often, which is the shape of a private conversation even with every word removed.
   * So the event is recorded (losing it is worse) and owned by nobody, and `length` is not stored:
   * this service has no use for it and a length is still a fact about a message.
   */
  'agora.whisper.sent': {
    payloadKeys: [],
    category: 'community',
    type: 'agora.whisper_sent',
    visibility: 'internal',
    userId: () => null,
    summary: () => 'A whisper was sent.',
  },
  /**
   * THE REPORTER IS NOT IN THE PAYLOAD, and that is agora's decision rather than this file's.
   *
   * The subject of a report is never told who filed it, and agora's emit site argues that leaving
   * the reporter off the bus is the only version of that rule which does not depend on every
   * subscriber choosing not to show it. There is therefore nobody to attribute this to, and
   * inventing an owner from the envelope actor would undo the guarantee in one line.
   */
  'agora.report.filed': {
    payloadKeys: ['subjectKind'],
    category: 'community',
    type: 'agora.report_filed',
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const kind = text(event, 'subjectKind', 16)
      return kind ? `A ${kind} was reported.` : 'Something was reported.'
    },
  },
  /**
   * The operator's log, not the affected person's.
   *
   * A suspension reaches the suspended reader through `agora.voice.suspended` above, which names
   * them. This topic is keyed by the subject acted upon so that every action against one post or
   * one voice is a single ordered stream — what an appeal is answered from — and it is `internal`
   * with no owner because the operator is staff and the subject already has their own record.
   */
  'agora.moderation.acted': {
    payloadKeys: ['action'],
    category: 'community',
    type: 'agora.moderation_acted',
    visibility: 'internal',
    userId: () => null,
    summary: (event) => {
      const action = text(event, 'action', 32)
      return action ? `A moderator acted: ${action}.` : 'A moderator acted on a report.'
    },
  },
  /**
   * `internal`, but OWNED — and the pairing is deliberate rather than an oversight.
   *
   * The reader is about to be emailed this notification and will read it in agora itself; a second
   * copy in their timeline saying a mail was sent is the same news told twice, so it stays out of
   * the feed. It still resolves its owner, because an unowned record is one that `eraseUser` in
   * `records.ts` cannot reach — an internal row is not an ownerless one.
   *
   * `detail` is undeclared and dropped. agora caps it at 200 characters of notification prose
   * precisely so a mailer can build a subject line; this service builds nothing from it, and
   * storing it would keep a fragment of somebody's notification in a service that has no reason
   * to hold one.
   */
  'agora.notification.mail_requested': {
    payloadKeys: ['subject', 'kind'],
    category: 'community',
    type: 'agora.notification_mailed',
    visibility: 'internal',
    userId: userFromSubjectField('subject'),
    summary: (event) => {
      const kind = text(event, 'kind', 24)
      return kind ? `A ${kind} notification was mailed.` : 'A notification was mailed.'
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
 * **The table as a LOOKUP, which is a different type from the table as a literal.**
 *
 * `CLASSIFIERS` is an object literal, so `CLASSIFIERS[topic]` is typed from the keys that are
 * written down — it is `TopicClassifier`, never `TopicClassifier | undefined`, because
 * `noUncheckedIndexedAccess` widens an INDEX SIGNATURE and this is not one. That is exactly right
 * for the compile-time guarantee (`satisfies` below the table) and exactly wrong for the runtime
 * one, and the gap between the two is a defect that reached production:
 *
 * > `TypeError: Cannot read properties of undefined (reading 'payloadKeys')`
 *
 * `micro-contracts` registered five wallet topics this build had no classifier for. `known` is
 * computed from the REGISTRY (`ingest.ts`), so those five took the classified branch,
 * `CLASSIFIERS[topic]` was `undefined`, and the next line threw — `POST /ingest` 500s, the relay
 * retries for ever, and the feed stops. The old line read
 * `const classifier: TopicClassifier = CLASSIFIERS[envelope.topic]`, and the annotation was a bare
 * cast: it asserted the very thing that was false.
 *
 * The two builds are only ever in step when they are deployed together, which twenty-two
 * separately deployed services are not. So the lookup is typed `Partial` — an honest statement
 * that at RUNTIME a topic may have no entry — and the compiler now forces the `undefined` branch
 * to be handled rather than assumed away. Nothing is weakened: the table is still declared
 * `satisfies Readonly<Record<TopicName, TopicClassifier>>`, so a missing classifier is still a
 * compile error in this repository. This is what happens when that error is not the one you get,
 * because the registry moved in a package you consume.
 */
const CLASSIFIER_TABLE: Readonly<Partial<Record<TopicName, TopicClassifier>>> = CLASSIFIERS

/**
 * The quarantine record: written, kept, and owned by nobody.
 *
 * Losing an event silently is worse than filing it badly — the event is gone and nothing records
 * that it ever arrived. So the payload is kept, the topic is recorded, and the row can be
 * reclassified later from data that was never thrown away.
 */
function quarantine(envelope: EventEnvelope, subjectUrn: string): Classified {
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

/**
 * Classify a delivered event.
 *
 * `known` is false when the topic parsed and validated but is not in this build's REGISTRY — a
 * consumer that is behind its producers. It is not the only way to be behind, and treating it as
 * the only way is what crashed this service: a topic the registry carries and this TABLE does not
 * is the same situation one package later, and it takes the same path. Both quarantine.
 */
export function classify(envelope: EventEnvelope, known: boolean): Classified {
  const parsed = parseTopicName(envelope.topic)
  const aggregate = parsed.ok ? parsed.value.aggregate : 'unknown'
  const subjectUrn = subjectUrnFor(envelope.producer, aggregate, envelope.key)

  // One condition, asking the question that can actually be answered here: can THIS BUILD classify
  // this event? `known` alone asks whether the registry has heard of it, which is a fact about a
  // dependency rather than about this file.
  const classifier = known ? CLASSIFIER_TABLE[envelope.topic] : undefined
  if (classifier === undefined) return quarantine(envelope, subjectUrn)

  const userId = classifier.userId(envelope)
  const redaction = redactPayload(envelope.payload, classifier.payloadKeys)
  return {
    category: classifier.category,
    type: typeof classifier.type === 'function' ? classifier.type(envelope) : classifier.type,
    userId,
    subjectUrn,
    summary: classifier.summary(envelope),
    // `money`, not `amount`. This column is rendered by a frontend as a decimal figure beside
    // `assetCode` (`hub-web/src/pages/activity.tsx,202`), so a number of unknown scale here is
    // the same defect as one in the prose and not a safer place to put it. See `money`'s header.
    amount: money(envelope) ?? money(envelope, 'price'),
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
