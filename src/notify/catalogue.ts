/**
 * The event → notification mapping. AD-08's first sentence, made into a table.
 *
 * One rule per topic. A rule says which category and priority a notification takes, which
 * template renders it, who receives it, and — the part that carries the most weight — what its
 * `dedupe_key` is.
 *
 * ## Why the dedupe key is the interesting column
 *
 * There are two distinct duplicates to stop, and they need different mechanisms:
 *
 *   1. **The same event delivered twice.** Delivery is at-least-once (AD-10), so this is normal
 *      operation, not a fault. The `inbox` unique on `(topic, event_id)` stops it, in the same
 *      transaction as the notification is written.
 *   2. **One fact described by two different events.** A new device produces both
 *      `identity.session.created` and `identity.device.added`. Both are legitimate, both have
 *      different event ids, and the inbox cannot tell they are the same news. A user who gets two
 *      "new device" alerts for one sign-in learns to ignore them, which defeats the alert.
 *
 * So the two rules for that fact return the **same** `dedupe_key`, keyed on the device rather
 * than on the event, and the unique index on `(user_id, dedupe_key)` collapses them into one
 * notification. That is why the key is built from domain identifiers and never from `event.id`.
 *
 * ## Priorities are not opinions
 *
 * `critical` is exactly 04-domain-model §10.3's list — new device, password change, MFA change,
 * key export, withdrawal — and nothing else. It is tempting to promote more (an API key is a
 * credential; a large sale is exciting) and it must be resisted: every critical notification
 * ignores the user's preferences, and a `critical` set that grows is a preference page that
 * gradually stops working.
 *
 * ## One topic, two facts: `variant`
 *
 * Nearly every topic carries one fact, so a rule fixes its priority and its template once. One
 * does not. `settlement.outbound.failed` says a withdrawal ended without reaching the chain, and
 * its `refundable` field decides whether the money is **coming back** or is **held** — two
 * different sentences to the person whose money it is, and, because one of them is the only thing
 * in the estate that will ever tell them their funds are stuck, two different priorities.
 *
 * `variant` is how a rule says that, and its shape is the argument. The rule's own `priority` and
 * `templateId` are the fact that applies **when nothing is proven**; the variant carries a `when`
 * that must return true before its priority and template are used instead. So the safe reading is
 * what an absent, malformed or unknown field produces, by construction rather than by a default
 * somebody remembered to write the right way round. Both halves are enumerable — `outcomesOf` —
 * so the coverage tests that walk every priority and every template still see all of them.
 *
 * ## Coverage
 *
 * `catalogue.test.ts` asserts that every topic in the frozen registry is either mapped here or
 * listed in `NON_NOTIFYING_TOPICS` with a reason. A topic added to the registry that nobody
 * thought about therefore fails this service's build rather than silently notifying nobody.
 */

import { RETIRED_ASSETS } from '@cloudsforge/contracts-chain'
import { TOPICS, type TopicName } from '@cloudsforge/contracts-events'
import type { Category, Channel, Priority } from './model.ts'
import type { TemplateId } from './templates.ts'
import type { InboundEvent } from './events.ts'

export interface Recipient {
  readonly userId: string
  readonly params: Record<string, unknown>
  /**
   * Stable across a redelivery of this event **and** across any other event describing the same
   * fact. Built from domain identifiers; never from `event.id`, which is different on every
   * event and would therefore dedupe nothing.
   */
  readonly dedupeKey: string
  /** `cf:<service>:<type>:<id>` — 04-domain-model §0. What the notification is *about*. */
  readonly subjectUrn: string | null
}

/**
 * Who a rule decided to notify.
 *
 * "Nobody" is a supported answer, and there are two different reasons for it that an operator
 * must be able to tell apart:
 *
 *   - `not_applicable` — the rule looked at the event and decided it is not news. A sign-in from
 *     a device the user has used a hundred times. This is the system working.
 *   - `no_recipient` — the rule wanted to notify somebody and could not work out who, because the
 *     payload did not say. This is a producer to go and fix.
 *
 * Collapsing them into an empty array loses exactly the distinction that decides whether anyone
 * needs to do anything, which is why this is a union rather than a list that might be empty.
 */
export type RecipientSet =
  | { readonly kind: 'recipients'; readonly recipients: readonly [Recipient, ...Recipient[]] }
  | { readonly kind: 'none'; readonly reason: 'not_applicable' | 'no_recipient' }

/**
 * The other fact a topic carries, and the test an event must PASS to be read as that fact.
 *
 * Deliberately not "a function from event to priority". A function cannot be enumerated, so the
 * §10.3 coverage test could no longer list every critical notification and the template-coverage
 * test could no longer prove every template is reachable — both would have degraded into "trust
 * the closure", which is how the fifteen unreachable rules survived. Data with one predicate keeps
 * every outcome visible to a test while still letting the payload choose between them.
 *
 * The asymmetry is the point: the rule's own priority and template are what an event gets when
 * `when` does not fire, so the DEFAULT is whatever the rule declares and the variant has to be
 * earned. See the `settlement.outbound.failed` rule for the case this exists for.
 */
export interface Variant {
  readonly when: (event: InboundEvent) => boolean
  readonly priority: Priority
  readonly templateId: TemplateId
  /** Why this fact is different news from the rule's own, and why it is a different priority. */
  readonly why: string
}

/**
 * An address this event carries, which notify may keep and deliver to.
 *
 * ## Why this exists at all
 *
 * For the whole life of this service, **no user had an address on file**. `upsertTarget` in
 * `store.ts` had no production caller, no route in `server.ts` created a channel target, and
 * nothing in `pipeline.ts` wrote one. `channelsAvailable` therefore answered `['in_app']` for every
 * real person, `resolveRouting` routed to the floor channel and to nothing else, and every email
 * notification this service has ever produced was delivered in-app and to nobody by mail — with no
 * delivery row to look at, because a channel with no target is not a candidate. From outside it
 * presented as "I didn't receive any registration email."
 *
 * ## Why it is a property of the RULE rather than a branch in the pipeline
 *
 * The alternative is a topic name written into `pipeline.ts`, and this catalogue exists precisely so
 * that no module downstream of it has to know a topic's name. It is also the only shape a test can
 * walk: a rule that declares it learns an address can be checked against its template's parameters,
 * its `why` can be required to argue for keeping personal data, and a second rule that starts
 * learning one is visible in the same table as the first.
 *
 * ## What it deliberately does not do
 *
 * It does not mark the address verified. `channel_targets.verified_at` stays null, because the
 * event that teaches this service an address is a request to PROVE the address, not proof of it.
 * Nothing in the estate emits "this address is confirmed" today, so gating delivery on
 * `verified_at` would mean no mail was ever sent again — the same silence in a new place. When
 * identity emits a confirmation, it becomes a rule here with a `learns` of its own, and gating
 * becomes a one-line change to `targetsFor` that is finally safe to make.
 */
export interface LearnedAddress {
  /** Never `in_app`: the floor channel has no address, and `channel_targets` refuses a row for it. */
  readonly channel: Exclude<Channel, 'in_app'>
  /** The address this event carries for its recipients, or null if the payload did not carry one. */
  readonly read: (event: InboundEvent) => string | null
  /**
   * Whose address it is, read from the PAYLOAD and never inferred.
   *
   * Separate from `recipients` on purpose, and the separation is the whole safety property.
   * `forUser` falls back to the envelope actor when the payload names nobody, which is the right
   * answer for "who do I tell" and the wrong one for "whose address is this": a resend triggered by
   * anybody other than the account holder would durably re-point that person's email at an inbox
   * they do not own, and from then on every notification about their money — including the
   * `critical` ones §10.3 will not let them mute — goes to a stranger. Notifying the wrong person is
   * one bad notification; storing the wrong address is every future notification.
   *
   * So this reader must find the user explicitly or return null, and `learnAddress` stores nothing
   * when it does. The pipeline additionally requires the answer to be one of the rule's own
   * recipients, so a payload that names a third party cannot write a row for them either.
   */
  readonly subject: (event: InboundEvent) => string | null
  /** Why notify may keep this, and what goes wrong if it is stale. Read before adding a second. */
  readonly why: string
}

export interface Rule {
  readonly category: Category
  readonly priority: Priority
  readonly templateId: TemplateId
  /** Why this event is worth interrupting someone for. Read it before changing a priority. */
  readonly why: string
  readonly recipients: (event: InboundEvent) => RecipientSet
  /** Present only where one topic carries two materially different facts. See `Variant`. */
  readonly variant?: Variant
  /** Present where the event carries an address this service should be able to reach later. */
  readonly learns?: LearnedAddress
}

/** What a rule decided this particular event is: how loud, and in which words. */
export interface Outcome {
  readonly priority: Priority
  readonly templateId: TemplateId
}

/**
 * Resolve a rule against one event.
 *
 * `=== true` rather than a truthiness test on the predicate's result: the predicate is typed
 * `boolean`, and this is the second guard for the same reason its subject has one — a variant that
 * is reached by accident is a notification that says the wrong thing.
 */
export function outcomeOf(rule: Rule, event: InboundEvent): Outcome {
  if (rule.variant !== undefined && rule.variant.when(event) === true) {
    return { priority: rule.variant.priority, templateId: rule.variant.templateId }
  }
  return { priority: rule.priority, templateId: rule.templateId }
}

/** Every outcome a rule can produce. The coverage tests walk this, never `rule.priority` alone. */
export function outcomesOf(rule: Rule): readonly [Outcome, ...Outcome[]] {
  const base: Outcome = { priority: rule.priority, templateId: rule.templateId }
  if (rule.variant === undefined) return [base]
  return [base, { priority: rule.variant.priority, templateId: rule.variant.templateId }]
}

/* ------------------------------------------------------------------ payload readers */

/**
 * Read the first present string from a payload, tolerating both spellings.
 *
 * Event payloads are snake_case by the registry's own convention (`keyedBy: 'user_id'`), but
 * several producers are not written yet and JavaScript services reach for camelCase. Accepting
 * both costs one function and removes an entire class of "the notification was silently empty".
 */
function str(payload: Record<string, unknown>, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  }
  return fallback
}

function flag(payload: Record<string, unknown>, names: readonly string[]): boolean {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return false
}

/**
 * Whether a failed withdrawal's money is coming back.
 *
 * **`=== true`, and deliberately not `flag()`.** `flag` accepts `'true'` as a string and reads
 * several spellings, which is the right tolerance for a `new_device` marker and the wrong one
 * here: this predicate has to agree, byte for byte, with the consumer that actually moves the
 * money. `wallet/src/server.ts` writes `refundable: payload['refundable'] === true` and says
 * why — refunding a payment that really landed pays the user twice, and that error cannot be
 * undone. `activity/src/classify.ts` mirrors the same `=== true` so a feed entry can never
 * read "on its way back" beside a balance wallet is holding.
 *
 * So an absent field, a string, a number and a null all mean HELD, which is the safe direction and
 * the whole reason this is a predicate with one spelling rather than a tolerant reader. Telling
 * somebody their money is coming back when it is held is the expensive error; it is also the one a
 * careless default produces, so the default is arranged to be unreachable rather than correct.
 */
function refunded(payload: Record<string, unknown>): boolean {
  return payload['refundable'] === true
}

/**
 * The withdrawal a settlement outbound event is about.
 *
 * The key is a safe fallback here and only here among the withdrawal topics: the registry keys
 * `settlement.outbound.*` by `withdrawal_id`, so the key IS this id. It is emphatically not a
 * user, which is why `userIdOf` refuses to fall back to it for this topic.
 */
function withdrawalIdOf(event: InboundEvent): string {
  return str(event.payload, ['withdrawal_id', 'withdrawalId'], event.key)
}

/**
 * The withdrawal a `settlement.withdrawal.stuck` event is about.
 *
 * Separate from `withdrawalIdOf` because the fallback must be different, and getting it wrong is
 * silent: the registry keys this topic `chain:network`, so `event.key` here is `ethereum:mainnet`
 * and quoting it to support would name a chain instead of a withdrawal. The envelope's own id is
 * at least a unique handle on the message.
 */
function stuckWithdrawalIdOf(event: InboundEvent): string {
  return str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)
}

/**
 * Did the bytes reach the network? **Evidence only — absence is not a "no".**
 *
 * `settlement/src/withdrawals.ts` sends `broadcastAt` as an ISO string or `null`, and a row
 * reaches `stuck` from either `signed` or `broadcast`. `str` treats an empty string as absent, so
 * a blank field cannot read as a timestamp — the empty-string trap that keeps producing defects
 * in this codebase (`BigInt('') === 0n`) in its stringly form.
 */
function wasBroadcast(payload: Record<string, unknown>): boolean {
  return str(payload, ['broadcastAt', 'broadcast_at'], '').length > 0
}

/**
 * The user this event is about.
 *
 * Falls back to the envelope `key` when — and only when — the registry says that topic is keyed
 * by `user_id`. Using the key blindly would attribute a `wallet.deposit.confirmed` (keyed by
 * `wallet_id`) to a user whose id happens to look like a wallet's, which is the worst possible
 * failure for this service: telling the wrong person about someone else's money.
 */
function userIdOf(event: InboundEvent): string | null {
  const fromPayload = str(event.payload, ['user_id', 'userId'], '')
  if (fromPayload) return fromPayload
  const spec = TOPICS[event.topic as TopicName]
  if (spec && spec.keyedBy === 'user_id' && event.key) return event.key
  // An `actor` of `user:<id>` is the last resort: the actor caused the event, which for these
  // topics is nearly always the same person, but "nearly" is why it is last.
  if (event.actor.startsWith('user:')) return event.actor.slice('user:'.length) || null
  return null
}

/**
 * A SUBJECT resolved to the user id a notification row is keyed on — or to which kind of nobody.
 *
 * ## Why this is not `slice('user:'.length)` at each call site
 *
 * A subject is `user:<uuid>`, `service:<name>`, `operator:<id>` or `system` (04-domain-model §0),
 * and slicing without checking the prefix turns `service:mint` into a "user id" of `mint`. That
 * row is well-formed, insertable and filed against a user who does not exist — the custody defect
 * in its consumer-side form, and a real possibility here rather than a hypothetical: a market
 * listing may be owned by a service principal (`market/src/server.ts` takes the seller from
 * `subjectOf(principal)`), and a tessera parcel by whatever `ensureAccount` was handed.
 *
 * ## The two "nobody" answers, which must not collapse
 *
 * `not_applicable` means the producer said exactly who, and the answer is that they are not a
 * person to interrupt. `no_recipient` means the producer stopped spelling a subject — a bare uuid
 * is the likely form — and is a producer to go and fix. Returning `not_applicable` for a malformed
 * subject would swallow every affected notification while reporting the rule as working, which is
 * the "reports itself as delivered" failure this catalogue exists to make impossible. So an
 * unrecognised prefix is `no_recipient`, and only the three RECOGNISED non-user principals are
 * `not_applicable`.
 *
 * The `none` arm is deliberately shaped to be assignable to `RecipientSet`, so a caller returns it
 * unchanged rather than re-deriving a reason it might get wrong.
 */
export type SubjectResolution =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'none'; readonly reason: 'not_applicable' | 'no_recipient' }

export function userOfSubject(subject: string): SubjectResolution {
  if (!subject) return { kind: 'none', reason: 'no_recipient' }
  if (!subject.startsWith('user:')) {
    const known =
      subject.startsWith('service:') || subject.startsWith('operator:') || subject === 'system'
    return { kind: 'none', reason: known ? 'not_applicable' : 'no_recipient' }
  }
  const userId = subject.slice('user:'.length)
  // `user:` with nothing after it is malformed, not a principal. Never `not_applicable`.
  return userId ? { kind: 'user', userId } : { kind: 'none', reason: 'no_recipient' }
}

/**
 * identity's revocation reasons, in words a person can act on.
 *
 * The producer's vocabulary, not a guess: `identity/src/server.ts`
 * and `identity/src/sessions.ts`. An unrecognised reason falls back to a sentence that is
 * still true, because a new reason arriving from a newer identity must not blank the notification
 * — and the fallback is deliberately vague rather than wrong.
 */
const REVOCATION_REASONS: Readonly<Record<string, string>> = Object.freeze({
  password_changed: 'your password was changed',
  password_reset: 'your password was reset',
  signed_out_everywhere: 'you signed out everywhere',
  signed_out: 'you signed out',
})

/**
 * An email address off a payload, or null.
 *
 * Deliberately not `str(payload, ['email'], '')`. An address this service is about to STORE and
 * then send every future notification to is not the same kind of value as a wallet label: a
 * fallback would turn a producer's omission into a durable row addressed at a string that is not an
 * address, and every later delivery would fail `rejected` at a provider rather than being visibly
 * absent here. So the answer to "no address on this payload" is null, and the pipeline counts it.
 *
 * The check is one `@` with something either side and no whitespace, and it stops there on purpose:
 * anything more is a copy of a validator identity already ran before it accepted the address, and a
 * second, stricter copy in a consumer is how a legal address becomes undeliverable in one service
 * only.
 */
function emailOf(payload: Record<string, unknown>): string | null {
  const value = payload['email'] ?? payload['email_address'] ?? payload['emailAddress']
  if (typeof value !== 'string') return null
  // Lower-cased to match the producer. identity normalises on the way in and puts a unique index on
  // `lower(email)`, so it holds exactly one address per account and two spellings are one address to
  // it. `channel_targets_uniq` is on the raw string, so keeping the case here would make
  // `Alice@…` and `alice@…` two rows: `learnTarget` would deactivate one and activate the other on
  // every alternation, churning the target ids that "which address did we send that to" depends on.
  const address = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null
}

/**
 * A link a producer minted, or a page on this platform to fall back to.
 *
 * **The scheme is checked, and that is the whole of the guard.** `templates.ts` puts this value in
 * `path`, and `renderTemplate` resolves it with `new URL(path, base)` — which happily returns a
 * `javascript:` or `data:` URL unchanged, and would then put it in a mail body as the one thing the
 * message asks the reader to open. The event arrives over the signed `/ingest` path so the producer
 * is authenticated, but "the caller is authenticated" is not an argument for handing an arbitrary
 * scheme to a mail client, and the check costs a line.
 *
 * The fallback is a RELATIVE path, so `new URL` resolves it against `NOTIFY_PUBLIC_URL` and the
 * reader lands on the page where a new link can be requested. That is the honest degradation: a
 * verification mail whose link is missing is still a mail somebody can act on, whereas a blank link
 * resolves to the site root and tells them nothing.
 */
function safeLinkOf(
  payload: Record<string, unknown>,
  names: readonly string[],
  fallbackPath: string,
): string {
  let value: unknown
  for (const name of names) {
    if (payload[name] !== undefined) {
      value = payload[name]
      break
    }
  }
  if (typeof value !== 'string' || value.length === 0) return fallbackPath
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return fallbackPath
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : fallbackPath
}

function verifyLinkOf(payload: Record<string, unknown>, fallbackPath: string): string {
  return safeLinkOf(payload, ['verify_url', 'verifyUrl', 'url'], fallbackPath)
}

/**
 * The reset link, or the fallback — which the reset rule treats as "do not send this at all".
 *
 * Split from `verifyLinkOf` by the key names only; the scheme guard is the same one and lives in
 * `safeLinkOf` so there is one place a `javascript:` URL is refused rather than two that can drift.
 */
function resetLinkOf(payload: Record<string, unknown>, fallbackPath: string): string {
  return safeLinkOf(payload, ['reset_url', 'resetUrl', 'url'], fallbackPath)
}

/** `2026-07-30 04:12 UTC`. Deterministic on purpose: `Intl` output varies by ICU build. */
export function formatInstant(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * What a reward notification calls the thing that was earned. Shared by BOTH reward rules.
 *
 * ## The defect this replaces, and why the suite was green through all of it
 *
 * `emberkin.reward.granted` built this parameter as `` `${amount} Shards` `` — the unit typed
 * straight into the copy — so `reward.granted` ("You earned {{rewardName}} in {{titleName}}.",
 * `templates.ts`) delivered "You earned 250 Shards in Emberkin." in app and by mail.
 *
 * SHARD is RETIRED: `export const RETIRED_ASSETS: readonly AssetCode[] = Object.freeze(['SHARD'])`,
 * in `contracts/packages/chain/src/index.ts`, whose own comment is that nothing may be **newly**
 * denominated in it. Naming it to a player is the third time a retired asset has reached a user
 * surface (micro-org #15, #182, and #227, of which this is one row).
 *
 * The reason review never caught it is the more useful half. `catalogue.test.ts` asserted
 * `params['rewardName'] === '250 Shards'`, exactly, under the name "names the Shards" — so the
 * suite was green **because** of the defect and any correction to the copy failed a test. A test
 * that pins a literal is only worth having when the literal is the property being defended, and
 * the property here is the opposite one: that no unit is ever written down in this repository.
 * That test is gone; what replaced it pins derivation and pins the absence of a retired code
 * against `RETIRED_ASSETS` itself, so this cannot come back without the suite saying so.
 *
 * ## What is actually on the wire — read from both producers, not assumed
 *
 *   - `emberkin/src/seasons.ts` (`grantSeasonReward`) emits
 *     `{ seasonId, userId, reason, amount, journalEntryId }`.
 *   - `worlds/src/rewards.ts` (`grantReward`) emits `{ rewardId, seasonId, titleId, userId,
 *     reason, amountShards, journalEntryId, budgetRemainingShards }`.
 *
 * **Neither payload carries an asset code.** Both services do post `assetCode: 'SHARD'` when they
 * credit the player (`rewardPostings` in `emberkin/src/ledgerclient.ts` and
 * `worlds/src/ledgerclient.ts`), so the *ledger* knows the denomination — but that fact is not on
 * the event, notify is a bus consumer with no ledger client, and it cannot join to one. Writing
 * `EMBER` here instead would be the same class of error as `Shards`, one step further from the
 * evidence: a unit this service picked on behalf of the service that moved the money. Where the
 * engagement programmes re-denominate is #226, and it is theirs to decide, not this file's.
 *
 * ## Which is why an amount is only ever shown together with the unit it is in
 *
 * "You earned 250 in Emberkin" is not a smaller version of the truth; it is a number the reader
 * supplies their own unit for, and it is the shape this codebase calls a plausible screen over
 * nothing. The honest answer to "how much of what", when the event does not say what, is to name
 * the reward without a quantity and let the template's own `path` — `/play/rewards` — carry the
 * figure, on the surface owned by the service that denominated it.
 *
 * So the order is: a name the producer sent; else an amount **and** an asset code the producer
 * sent; else the named hole. The middle branch is dead against both of today's payloads and is
 * written anyway, because it is what makes this outlive the re-denomination — the day either
 * producer puts `asset_code` on its event, both notifications begin reading "250 EMBER" with no
 * edit here, and no unit will ever have been typed into this repository to get there.
 *
 * ## The one asset code that is refused even when the producer does send it
 *
 * `RETIRED_ASSETS` is consulted on the delivery path, and a retired code falls back to the named
 * hole along with its amount. That is a judgement and it is worth stating: elsewhere in this file
 * rendering SHARD is CORRECT — `ledger.entry.posted` passes through whatever `asset_code` the
 * ledger recorded, and `mint-web/src/lib/format.ts` deliberately shows a pre-migration order as
 * "2,500 SHARD", because both are describing a past fact that really is denominated that way. A
 * reward is not that. It is news about something a player has just been given, in an asset the
 * estate is winding down, and #227 exists because that distinction was not being drawn anywhere.
 *
 * The guard is the estate's LIST, not the string "SHARD", so it extends itself the next time an
 * asset is retired — which is the only version of it that is still working in a year.
 *
 * ## And why it is one function rather than two rules that happen to agree
 *
 * The two rules were inconsistent, which is part of what #227 reports: emberkin appended a unit
 * and `worlds.reward.granted` appended none. Neither was a decision; each was what its author
 * wrote on the day. One function is how the answer stays decided in one place, and it is also how
 * `worlds.reward.granted` gets the same asset-code branch for free — it had no amount at all
 * before, because it read `reward_name`/`rewardName`/`name` and worlds sends none of the three.
 */
export function rewardNameOf(payload: Record<string, unknown>): string {
  // A name a producer really sent beats a quantity: "the Ashen Blade" is the reward, and the
  // amount beside it would be a second thing. Kept from the worlds rule, which read exactly these
  // three spellings — see the note above about none of them being on the wire today.
  const named = str(payload, ['reward_name', 'rewardName', 'name'], '')
  if (named) return named
  // `amount` is emberkin's spelling, `amountShards`/`amount_shards` is worlds'. Reading a field
  // whose NAME says shards is not the same as writing shards into copy: the field name is the
  // producer's wire contract and is not read by anybody, the copy is.
  const amount = str(payload, ['amount', 'amount_shards', 'amountShards'], '')
  const asset = str(payload, ['asset_code', 'assetCode', 'asset'], '')
  if (amount && asset && !isRetired(asset)) return `${amount} ${asset}`
  return 'a reward'
}

/**
 * Which way did an exchange transfer go? **Evidence only — absence reads as a deposit.**
 *
 * `settleTransfer` sends `direction` as `'deposit'` or `'withdrawal'` off a column that admits
 * nothing else, so the two-way test is exhaustive against today's producer. The asymmetry is
 * deliberate and is the `wasBroadcast` argument: the DEFAULT is what an event gets when the field
 * is missing or a producer adds a third direction, and a deposit — money arriving somewhere new —
 * is the reading that cannot mislead a reader about where their money is. A withdrawal has to be
 * earned by the producer saying so.
 */
function isWithdrawalFrom(payload: Record<string, unknown>): boolean {
  return str(payload, ['direction'], '') === 'withdrawal'
}

/**
 * Did a fee settlement collect the whole assessment? **Evidence only — absence reads as a full
 * charge.**
 *
 * ## Why the producer's verdict, and never `due - collected` computed here
 *
 * The event carries both figures, so this could subtract them. It must not, and the reason is the
 * empty-string trap this codebase keeps rediscovering: `due` and `collected` are strings off a
 * `numeric(78,0)` column, `BigInt('')` is `0n`, and a payload that dropped `due` — every
 * `trade.fee.settled` emitted before micro-org#367 landed, and any replay of one — would compare
 * `collected >= 0n` and read a partial collection as a full charge, silently, on the money path.
 * `str` treats an empty string as absent, which is the whole reason the readers in this file go
 * through it.
 *
 * The second reason outlives that one. `settleFee` computes `collected >= due ? 'charged' :
 * collected > 0n ? 'partial' : 'uncollectable'` and writes that verdict to `fee_settlements.status`
 * in the same statement it emits from, and the settlement history the mail sends the reader to is
 * rendered off that column. A comparison re-implemented here is a second opinion that can disagree
 * with the row the user is looking at — the notification saying one thing and the page it links to
 * saying another, which is worse than either being wrong on its own.
 *
 * ## Which direction the default points, and why that one
 *
 * `charged` is what an event gets when the field is missing, misspelled or a value this build does
 * not know — the `isWithdrawalFrom` asymmetry, aimed the other way for the same reason. Reading an
 * unknown status as `partial` would tell a customer who paid in full that they are in arrears, and
 * every pre-#367 payload would say it: a demand for money that is not owed, sent by the platform,
 * with a settlement history that contradicts it. The failure in the other direction is a customer
 * who is told the fee was taken and finds the remainder on their next settlement, where it is
 * itemised. One is a false accusation, the other is an incomplete but true account.
 *
 * `'partial'` exactly, byte for byte with the producer's `SettlementStatus`, rather than `flag`'s
 * tolerance. And one spelling rather than two: `status` is a single word, so the snake/camel
 * tolerance `str` exists for has nothing to do here — unlike this rule's `settlement_id`/
 * `settlementId` and `bot_id`/`botId`, which really are spelled both ways by producers.
 *
 * ## The status this can never see
 *
 * `uncollectable`. `settleFee` guards the emit with `if (collected > 0n)`, deliberately and with
 * the argument written at the emit site: a settlement that moved no money would render as a charge
 * that did not happen. So there is no third branch here and no third template — the arrears fact
 * wants a topic of its own, and micro-org#367 files it rather than smuggling it in under this name.
 */
function isPartialCollection(payload: Record<string, unknown>): boolean {
  return str(payload, ['status'], '') === 'partial'
}

/**
 * Is this payload's asset code one the estate is winding down?
 *
 * The list rather than contracts' own `isRetiredAsset(asset: AssetCode)` in
 * `contracts/packages/chain/src/index.ts`, and the difference is the argument, which its signature
 * makes for itself: that helper takes an `AssetCode`, and this string came off a
 * payload. Narrowing it first would need a validator whose only possible verdict on an unknown
 * code is "not retired" — the right answer, reached by a longer route, with a second place for the
 * two lists to disagree. Upper-cased because a producer's spelling is not this service's to
 * assume, and `RETIRED_ASSETS` holds the canonical casing.
 */
function isRetired(asset: string): boolean {
  const code = asset.toUpperCase()
  return (RETIRED_ASSETS as readonly string[]).includes(code)
}

/**
 * Build a rule whose recipient is the single user the event is about.
 *
 * Nearly every rule has this shape, and writing it once means a new rule cannot forget the
 * `userIdOf` fallback logic or the "no user, no notification" branch.
 */
function forUser(
  dedupe: (event: InboundEvent) => string,
  params: (event: InboundEvent) => Record<string, unknown>,
  subject: (event: InboundEvent) => string | null = () => null,
  applies: (event: InboundEvent) => boolean = () => true,
): Rule['recipients'] {
  return (event) => {
    if (!applies(event)) return { kind: 'none', reason: 'not_applicable' }
    const userId = userIdOf(event)
    if (!userId) return { kind: 'none', reason: 'no_recipient' }
    return {
      kind: 'recipients',
      recipients: [
        { userId, params: params(event), dedupeKey: dedupe(event), subjectUrn: subject(event) },
      ],
    }
  }
}

/* ------------------------------------------------------------------ the table */

export const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  /* --------------------------------------------------------- security · critical
   *
   * Exactly 04-domain-model §10.3's list. Every one of these ignores preferences.
   */

  'identity.session.created': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.new_device',
    why: 'A sign-in from an unrecognised device is the first observable symptom of a stolen password.',
    recipients: forUser(
      // Keyed on the device, not the session: the same device signing in twice in a minute is one
      // piece of news, and `identity.device.added` below produces this same key for the same fact.
      (event) => `security.new_device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
      (event) => ({
        device: str(event.payload, ['device_label', 'deviceLabel', 'user_agent', 'userAgent'], 'an unrecognised device'),
        ipPrefix: str(event.payload, ['ip_prefix', 'ipPrefix'], 'unknown'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:identity:device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
      // A sign-in from a device the user has used before is not news. Only the new ones are, and
      // sending all of them is how a security alert becomes background noise.
      (event) => flag(event.payload, ['new_device', 'newDevice', 'first_seen', 'firstSeen']),
    ),
  }),

  'identity.device.added': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.new_device',
    why: 'The same fact as a new-device sign-in, from the device register rather than the session.',
    recipients: forUser(
      (event) => `security.new_device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
      (event) => ({
        device: str(event.payload, ['device_label', 'deviceLabel', 'user_agent', 'userAgent'], 'an unrecognised device'),
        ipPrefix: str(event.payload, ['ip_prefix', 'ipPrefix'], 'unknown'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:identity:device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
    ),
  }),

  /**
   * A password change, an admin revocation, and the burn that follows a stolen refresh token.
   *
   * This replaces a rule on `identity.password.changed` — a topic **no producer has ever
   * emitted**. identity does not announce a password change as its own fact; it revokes every
   * session and says why, at `identity/src/server.ts` (`password_changed`)
   * (`password_reset`) (`signed_out_everywhere`) and (`signed_out`). So the §10.3
   * password-change notification was written against a name that does not exist, and this is the
   * event that actually carries the fact.
   *
   * An ordinary sign-out is deliberately NOT news: the user just did it, in this application, and
   * confirming it is how a security channel is trained into background noise. Everything else is —
   * a revocation the user did not perform is the visible half of an account takeover.
   *
   * NOTE for whoever wires the producer: `emitSessionRevoked` (identity/src/sessions.ts) has
   * no caller. `revokeSession` and `revokeAllSessions` update the rows without emitting, so this
   * rule is correct and silent until identity calls it from those two functions.
   */
  'identity.session.revoked': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.session_revoked',
    why: 'A session ended by somebody other than the user is an account takeover in progress, and the password-change case is 04-domain-model §10.3 word for word.',
    recipients: forUser(
      // Keyed on the session: one revocation, one notification, however often it is redelivered.
      // "Sign out everywhere" revokes many sessions and produces one notification per session,
      // which is correct — each is a device losing access — and the dedupe key says so.
      (event) => `security.session_revoked:${str(event.payload, ['session_id', 'sessionId'], event.key)}`,
      (event) => ({
        reason: REVOCATION_REASONS[str(event.payload, ['reason'], '')] ?? 'it was revoked',
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:identity:session:${str(event.payload, ['session_id', 'sessionId'], event.key)}`,
      // The one reason that is not news. Every other value — including one this build has never
      // seen — notifies, because an unrecognised reason is exactly when the user should look.
      (event) => str(event.payload, ['reason'], '') !== 'signed_out',
    ),
  }),

  /*
   * `remainingActive` leads the field list on both rules below, and that is the producer's
   * spelling rather than a third guess.
   *
   * identity used to emit neither of these topics — it emitted `identity.mfa.changed`, which no
   * registry declared and no consumer here classified, so both of these rules were unreachable
   * for the whole life of the service. Now that it emits `identity.mfa.removed` and
   * `identity.mfa.added` the payload has to be read with the names it actually carries, and
   * identity calls this count `remainingActive` — the same word its `FactorRemoved` result and its
   * `hasActiveFactor` query use. The older spellings stay in the list because a fallback that
   * has never been wrong costs nothing, and because `str` needs a last resort anyway.
   */

  'identity.mfa.removed': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.mfa_changed',
    why: 'Removing the last second factor leaves the account on its password alone, and today nothing tells the owner.',
    recipients: forUser(
      (event) => `security.mfa_changed:${str(event.payload, ['factor_id', 'factorId'], event.id)}`,
      (event) => ({
        change: 'removed',
        at: formatInstant(event.occurredAt),
        remainingFactors: str(
          event.payload,
          ['remaining_active', 'remainingActive', 'remaining_factors', 'remainingFactors'],
          // `wasLast` is the producer's flag for "this account now has no second factor". It is
          // the honest zero, and it was previously spelled `change: 'last_factor_removed'` on a
          // topic nothing subscribed to, so this fallback had never once fired either.
          flag(event.payload, ['was_last', 'wasLast']) ? '0' : 'unknown',
        ),
      }),
    ),
  }),

  'identity.mfa.added': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.mfa_changed',
    why: 'A second factor added by an attacker is how they keep an account after the password is reset.',
    recipients: forUser(
      (event) => `security.mfa_changed:${str(event.payload, ['factor_id', 'factorId'], event.id)}`,
      (event) => ({
        change: 'added',
        at: formatInstant(event.occurredAt),
        remainingFactors: str(
          event.payload,
          ['remaining_active', 'remainingActive', 'remaining_factors', 'remainingFactors'],
          'unknown',
        ),
      }),
    ),
  }),

  'custody.export.requested': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.key_export_requested',
    why: 'The registry says it outright: notify must reach every channel before the 24-hour cooling-off ends. This notification is the cooling-off period doing its job.',
    recipients: forUser(
      (event) => `security.key_export_requested:${str(event.payload, ['export_id', 'exportId', 'wallet_id', 'walletId'], event.id)}`,
      (event) => ({
        walletLabel: str(event.payload, ['wallet_label', 'walletLabel', 'wallet_id', 'walletId'], 'a wallet'),
        at: formatInstant(event.occurredAt),
        availableAt: formatInstant(
          str(event.payload, ['available_at', 'availableAt'], new Date(Date.parse(event.occurredAt) + 86_400_000).toISOString()),
        ),
      }),
      (event) => `cf:custody:export:${str(event.payload, ['export_id', 'exportId'], event.id)}`,
    ),
  }),

  'custody.key.exported': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.key_exported',
    why: 'A private key left the platform accompanied by a single log line. §10.3 names this as the notification a user may not opt out of.',
    recipients: forUser(
      (event) => `security.key_exported:${str(event.payload, ['key_id', 'keyId', 'wallet_id', 'walletId'], event.id)}`,
      (event) => ({
        walletLabel: str(event.payload, ['wallet_label', 'walletLabel', 'wallet_id', 'walletId'], 'a wallet'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:custody:key:${str(event.payload, ['key_id', 'keyId'], event.id)}`,
    ),
  }),

  'wallet.withdrawal.requested': Object.freeze({
    category: 'withdrawal',
    priority: 'critical',
    templateId: 'withdrawal.requested',
    why: 'Money leaving is on §10.3’s critical list. The window between request and broadcast is the only window in which a user can stop a theft.',
    recipients: forUser(
      (event) => `withdrawal.requested:${str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'an amount'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        destination: str(event.payload, ['destination', 'to_address', 'toAddress'], 'an external address'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:wallet:withdrawal:${str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)}`,
    ),
  }),

  /* --------------------------------------------------------- security · high */


  /* --------------------------------------------------------- account and wallet */

  'identity.user.registered': Object.freeze({
    category: 'account',
    priority: 'normal',
    templateId: 'account.registered',
    why: 'The first thing the platform ever says to someone.',
    // ── THIS COMMENT USED TO EXPLAIN WHY THERE WAS NO `learns`. IT WAS THE BUG (micro-org#447) ──
    //
    // What stood here: "No `learns`, and that is a statement about the producer rather than a
    // decision here. identity's registration payload is `{ userId, handle, organisationId,
    // organisationSlug }` and carries **no address at all**, so there is nothing on this event
    // for this service to keep. The address arrives on the verification event below."
    //
    // Every sentence of that was true, and the conclusion drawn from it was wrong. "The address
    // arrives on the verification event" describes a LATER event; this rule fans out when THIS
    // one is ingested, against the targets held at that moment. There were none. So the welcome
    // mail — "the first thing the platform ever says to someone" — was routed to in-app only and
    // has never been emailed to anybody in the life of this estate. Not delayed: never sent.
    //
    // identity now puts the normalised address on the registration payload, so this learns it.
    // `learnAddress` runs before `createNotification` in the same transaction (pipeline.ts), so
    // the target exists when this notification routes, and no ordering is left to chance.
    learns: {
      channel: 'email' as const,
      read: (event: InboundEvent) => emailOf(event.payload),
      subject: (event: InboundEvent) => str(event.payload, ['user_id', 'userId'], '') || null,
      why: 'The account was just created, so this is the first moment the address exists anywhere and the first moment a target can be written for it. Same mirror, and the same one-active-row rule, as the verification rule below — see its `why` for what the mirror is for and where it goes stale.',
    },
    recipients: forUser(
      (event) => `account.registered:${event.key}`,
      (event) => ({ handle: str(event.payload, ['handle'], 'there') }),
      (event) => `cf:identity:user:${event.key}`,
    ),
  }),

  /**
   * How this service comes to know an email address at all — and the mail the owner did not get.
   *
   * ## Why the dedupe key is the event id, in the one place that is right
   *
   * This file's header says a dedupe key is "built from domain identifiers and never from
   * `event.id`", and the reason is that two events can describe one fact — a new device produces
   * two topics and must produce one alert. **A verification request is the opposite shape.** Each
   * one mints a NEW single-use link and invalidates nothing; two requests are two facts, and a key
   * that collapsed them would mean a reader who asked for a second link because the first went
   * astray received nothing at all, for ever, and could never finish signing up. Redelivery of one
   * request is already stopped where it belongs, by the inbox unique on `(topic, event_id)`.
   *
   * If identity ever puts a request id on the payload it should be keyed on that instead: it is the
   * same fact under a stabler name. It does not today, and the token is emphatically not a
   * candidate — `dedupe_key` is returned by `GET /notifications`.
   *
   * ## `high`, not `critical`
   *
   * §10.3's critical list is closed and `catalogue.test.ts` pins it to exactly eight topics. This is
   * not on it and must not join it: `critical` means "delivered whatever the user's preferences
   * say", which is right for a key leaving and wrong for a message the reader can ask for again.
   * `high` clears every default preference (`DEFAULT_PREFERENCE`, `routing.ts`), and a brand-new
   * account has no preferences to clear anyway.
   */
  'identity.email.verification_requested': Object.freeze({
    category: 'account',
    priority: 'high',
    templateId: 'account.verify_email',
    why: 'The address is unusable until it is proved, and this is the only message that proves it. It is also the mail whose absence was reported: the estate had every SMTP variable set and no user with an address to send to.',
    learns: {
      channel: 'email' as const,
      read: (event: InboundEvent) => emailOf(event.payload),
      // The payload, and nothing else. Not `userIdOf`, whose last resort is the envelope actor —
      // see `LearnedAddress.subject` for what that costs when a resend is triggered by anybody but
      // the account holder.
      subject: (event: InboundEvent) => str(event.payload, ['user_id', 'userId'], '') || null,
      why: 'identity owns the address and holds exactly one per user (`users_email_lower_uniq`). This is a mirror kept so that a withdrawal alert at three in the morning does not depend on identity answering; `learnTarget` in store.ts keeps it to one active row so the mirror cannot fan out. It goes stale if the address changes in identity and identity announces no such change — that is a named gap, not an accepted one, and it closes the day identity emits the event, which becomes a `learns` here and nothing else.',
    },
    recipients: forUser(
      (event) => `account.verify_email:${event.id}`,
      (event) => ({
        handle: str(event.payload, ['handle'], 'there'),
        // Falls back to the page that can issue a new link. See `verifyLinkOf`: a scheme this
        // service will not put in a mail body degrades to the same place.
        verifyUrl: verifyLinkOf(event.payload, '/settings/account'),
      }),
      (event) => `cf:identity:user:${str(event.payload, ['user_id', 'userId'], event.key)}`,
    ),
  }),

  /**
   * The reset mail — the sibling of the rule above, and the reason `deliverPasswordReset` stopped
   * being a seam that sent nothing.
   *
   * `identity/src/passwordReset.ts` hard-returned `{ delivered: false, channel: 'none' }` for the
   * life of the service: `POST /auth/password/forgot` answered 202, recorded the token, logged
   * `password_reset_undelivered`, and mailed nobody. Its own header said that was the supported
   * mode "until `notify` exists". It exists, so this is the rule that mode was waiting for.
   *
   * ## Three deliberate differences from the verification rule
   *
   *   1. **`security`, not `account`.** A password reset is the one message a person receives when
   *      somebody — possibly not them — is taking their account. It files where they look for that.
   *   2. **No link, no notification.** `verifyLinkOf` degrades to a page that can issue a new
   *      link, which is honest for a reader who is SIGNED IN. A reset reader is signed out by
   *      definition and this platform has no page for them yet, so the same degradation would send
   *      a mail that says "someone is resetting your password" and offers nothing to do about it —
   *      the shape of a phishing message, sent by us. `applies` refuses instead, which counts as
   *      `not_applicable` and shows up as a producer defect rather than as a mail nobody can use.
   *   3. **The dedupe key is the event id**, for the reason the verification rule gives above and
   *      more strongly: each request mints a NEW link and supersedes the last, so collapsing two
   *      would leave somebody who clicked twice holding the only link that no longer works.
   *
   * `high` and never `critical`: §10.3's critical list is closed and pinned to eight topics. A
   * reset can be asked for again, which is exactly what `critical` is not for.
   *
   * `learns` matters MORE here than on the verification event. Every account created before
   * `identity.email.verification_requested` shipped has no `channel_targets` row at all, and a
   * password reset is precisely the message such an account needs; without this the mail would be
   * rendered and addressed to nobody.
   */
  'identity.password.reset_requested': Object.freeze({
    category: 'security',
    priority: 'high',
    templateId: 'security.password_reset',
    why: 'The only message that lets somebody who has lost their password get back in. Without it the request is recorded and nothing is sent, which is what identity did until this rule existed — a 202 and a warn line, and a user waiting for mail that was never going to arrive.',
    learns: {
      channel: 'email' as const,
      read: (event: InboundEvent) => emailOf(event.payload),
      // The payload, never the envelope actor: an operator-issued reset carries
      // `operator:<id>` there, and learning that as the account's address would point every future
      // notification for the user at a member of staff.
      subject: (event: InboundEvent) => str(event.payload, ['user_id', 'userId'], '') || null,
      why: 'identity owns the address and holds exactly one per user. This event carries it for the same reason the verification event does, and for one more: an account that predates verification has no target row here at all, so a reset would otherwise render a mail with nowhere to send it.',
    },
    recipients: forUser(
      (event) => `security.password_reset:${event.id}`,
      (event) => ({
        handle: str(event.payload, ['handle'], 'there'),
        resetUrl: resetLinkOf(event.payload, ''),
      }),
      (event) => `cf:identity:user:${str(event.payload, ['user_id', 'userId'], event.key)}`,
      // See difference 2 above. The empty fallback is the sentinel and it is checked here rather
      // than rendered: a template whose whole body is a link must not go out without one.
      (event) => resetLinkOf(event.payload, '') !== '',
    ),
  }),

  /**
   * An external address became somewhere money can leave to — and the reverse.
   *
   * Both topics were registered by `micro-contracts` and mapped by nothing, which is the state the
   * coverage ratchet exists to make loud: the suite went red rather than the notification going
   * quietly missing. See micro-org #211 for what that cost in the meantime (no notify image
   * published at all while it stood).
   *
   * They are `security` and not `wallet` because a link is authorised by a SIGNATURE and not by a
   * password: an attacker holding the account adds their own address, and from then on the theft is
   * indistinguishable from an ordinary withdrawal. The revocation is the same event seen from the
   * other side and is worth the same interruption.
   *
   * `high`, not `critical`: §10.3's critical list is closed and pinned to eight topics.
   *
   * Keyed on the wallet, which is the registry's own `keyedBy` for both, so the pair cannot
   * collapse into one another and a re-link after a revoke is its own message.
   */
  'wallet.link.verified': Object.freeze({
    category: 'security',
    priority: 'high',
    templateId: 'security.wallet_link_verified',
    why: 'The moment an address this platform does not control becomes a legal destination for the user money. If somebody else did it, this is the last message before the balance leaves.',
    recipients: forUser(
      (event) => `wallet.link.verified:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
      (event) => ({
        chain: str(event.payload, ['chain'], 'external'),
        // In full and never truncated — see the template. A lookalike address is caught by
        // reading it, and by nothing else.
        address: str(event.payload, ['address'], 'an address shown in your wallet'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:wallet:wallet:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
    ),
  }),

  'wallet.link.revoked': Object.freeze({
    category: 'security',
    priority: 'high',
    templateId: 'security.wallet_link_revoked',
    why: 'A withdrawal destination being removed is an account takeover seen from the other side, and it is the half a user never hears about anywhere else.',
    recipients: forUser(
      (event) => `wallet.link.revoked:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
      (event) => ({
        authorisation: str(event.payload, ['authorisation'], 'withdrawals'),
        walletId: str(event.payload, ['wallet_id', 'walletId'], event.key),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:wallet:wallet:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
    ),
  }),

  'wallet.wallet.created': Object.freeze({
    category: 'wallet',
    priority: 'normal',
    templateId: 'wallet.created',
    why: 'A wallet the user did not create is a symptom worth surfacing, and a wallet they did create is a confirmation they expect.',
    recipients: forUser(
      (event) => `wallet.created:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
      (event) => ({
        walletLabel: str(event.payload, ['label', 'wallet_label', 'walletLabel'], 'a new wallet'),
        chain: str(event.payload, ['chain', 'network'], 'a supported chain'),
      }),
      (event) => `cf:wallet:wallet:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
    ),
  }),

  /* --------------------------------------------------------- money */


  'wallet.deposit.confirmed': Object.freeze({
    category: 'deposit',
    priority: 'high',
    templateId: 'deposit.confirmed',
    why: 'The money is spendable. This is the moment the user is waiting for and the one they currently poll for.',
    recipients: forUser(
      (event) => `deposit.confirmed:${str(event.payload, ['deposit_id', 'depositId', 'tx_hash', 'txHash'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'A deposit'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
      }),
      (event) => `cf:wallet:deposit:${str(event.payload, ['deposit_id', 'depositId', 'tx_hash', 'txHash'], event.id)}`,
    ),
  }),

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * THE OPPOSITE FACT TO THE ONE ABOVE, AND IT NEEDS ITS OWN RULE — micro-org#200.
   *
   * `wallet.deposit.confirmed` says money is spendable. This says money arrived and is **not**:
   * a token transfer reached a custodial deposit address, and `micro-wallet` will not credit it,
   * because crediting a `TOKEN:` asset needs decimals it has no source for, a `chain_assets` row
   * only `micro-ledger` may write, a `micro-pricing` route that answers for the urn — it answers
   * `404 not_found` — and a withdrawal path that does not exist. Until this rule the event did not
   * exist either: the transfer was consumed and discarded and nobody was ever told.
   *
   * ── `high`, not `critical` ────────────────────────────────────────────────────────────────
   *
   * `critical` is 04-domain-model §10.3's list exactly — new device, password change, MFA change,
   * key export, withdrawal — and this is not on it. It is tempting, because the sentence is
   * alarming; the rule is that `critical` ignores the user's preferences, and a `critical` set
   * that grows on urgency is a preference page that gradually stops working. `high` is where
   * `deposit.confirmed` sits and this is the same kind of news about the same money.
   *
   * ── Keyed on the movement, not the event ──────────────────────────────────────────────────
   *
   * The dedupe key is the sighting, so a redelivery and a reorg re-emit of one arrival are one
   * notification. `micro-wallet` already collapses these at its end — the row is unique on
   * `(chain, network, tx_hash, log_index)` and only a first insert emits — and this is the second
   * belt, in the service whose duplicate a user would actually see.
   *
   * ── The recipient is read, never inferred ─────────────────────────────────────────────────
   *
   * `userIdOf` falls back to the envelope key only for topics the registry declares
   * `keyed_by: user_id`. This one is keyed by `wallet_id`, exactly as `wallet.deposit.confirmed`
   * is, so that fallback is correctly unavailable — and attributing a wallet id to a user is the
   * single worst mistake this service can make. `micro-wallet` therefore puts `userId` on the
   * payload, which `userIdOf` reads first and prefers anyway. This rule cannot address a stranger
   * by accident, because there is nothing here for it to guess with.
   *
   * ── The registration had to come first, and did ───────────────────────────────────────────
   *
   * `micro-contracts` registered the topic (micro-contracts#5) before this landed. That ordering
   * is not politeness: `validateEnvelope` refuses an unregistered name and the producer's relay
   * quarantines on that verdict rather than delivering, so a rule written ahead of the registry is
   * a rule that cannot fire — the state `AWAITING_REGISTRATION` exists to make visible, and one
   * this change did not need to enter.
   *
   * ── The params are three strings and not an amount ────────────────────────────────────────
   *
   * There is deliberately no `amount` and no `asset` here, and the template header says why: the
   * producer sends smallest units with no decimals because it has none, and rendering them beside
   * a token name would state a figure that may be wrong by a factor of 10^12.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  'wallet.deposit.token_uncredited': Object.freeze({
    category: 'deposit',
    priority: 'high',
    templateId: 'deposit.token_uncredited',
    why: 'Money reached an address the platform controls and is in no balance. Nothing else in the estate will ever tell the user that, and a second transfer to the same address is the harm this prevents.',
    recipients: forUser(
      (event) =>
        `deposit.token_uncredited:${str(event.payload, ['sighting_id', 'sightingId', 'tx_hash', 'txHash'], event.id)}`,
      (event) => ({
        chain: str(event.payload, ['chain'], 'your'),
        contract: str(event.payload, ['token_address', 'tokenAddress', 'asset_code', 'assetCode'], 'unknown'),
        txHash: str(event.payload, ['tx_hash', 'txHash'], 'unknown'),
      }),
      (event) =>
        `cf:wallet:deposit:${str(event.payload, ['sighting_id', 'sightingId', 'tx_hash', 'txHash'], event.id)}`,
    ),
  }),

  'settlement.withdrawal.completed': Object.freeze({
    category: 'withdrawal',
    priority: 'high',
    templateId: 'withdrawal.completed',
    why: 'Confirms the money arrived and gives the user the transaction hash before they ask support for it.',
    recipients: forUser(
      (event) => `withdrawal.completed:${event.key}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'Your withdrawal'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        destination: str(event.payload, ['destination', 'to_address', 'toAddress'], 'the destination address'),
        txHash: str(event.payload, ['tx_hash', 'txHash'], 'pending'),
      }),
      (event) => `cf:settlement:withdrawal:${event.key}`,
    ),
  }),

  /**
   * A withdrawal past its deadline. **Late is not failed, and the funds are HELD.**
   *
   * This rule rendered `withdrawal.failed` — "Nothing has left your balance. You can try again." —
   * and both halves were false here. The reservation moves `available → reserved` at request time
   * and going stuck returns none of it: `markStuck` is "never a refund"
   * (`settlement/src/worker.ts`), and wallet's twin sweep "does not refund anything — the
   * payment may have landed" (`wallet/src/withdrawals.ts`). So the one sentence the mail
   * existed to reassure with told a user their money was untouched while it was reserved and
   * unspendable, and the retry it invited would have taken a second reservation out of what was
   * left. See `withdrawal.stuck` in `templates.ts` for the rest of the reasoning.
   *
   * ## The variant is earned, not assumed
   *
   * `stuck` is reached from `signed` or `broadcast`, so "is there a transaction on the network"
   * has two answers and the payload's `broadcastAt` is the only evidence either way. The rule's
   * own template is the one that claims nothing; the variant fires only where `broadcastAt` is a
   * non-empty string. An absent field is not proof of a state, so it gets the reading that holds
   * for both.
   *
   * ## The dedupe key names the disposition
   *
   * It was `withdrawal.failed:<id>`, which collided in meaning with the rule below that genuinely
   * reports a failure — the same "name the disposition" argument that rule's own comment makes.
   * The two stuck halves key separately on purpose: a withdrawal that goes stuck unsent and is
   * then broadcast has changed news, and the second message must not dedupe into the first.
   *
   * `event.id` is the fallback for the withdrawal id and NOT `event.key`, because the registry
   * keys this topic `chain:network`. `withdrawalIdOf` is safe only for `settlement.outbound.*`.
   */
  'settlement.withdrawal.stuck': Object.freeze({
    category: 'withdrawal',
    // The default: we do not know that anything reached the network. See the variant.
    priority: 'high',
    templateId: 'withdrawal.stuck',
    why: 'An outbound transaction past its deadline, with the amount reserved and unspendable meanwhile. Silence here is a user who believes their money has vanished; the old wording was worse, telling them it had never moved.',
    variant: Object.freeze({
      when: (event) => wasBroadcast(event.payload),
      priority: 'high',
      templateId: 'withdrawal.stuck_sent',
      why: 'A `broadcastAt` is evidence the bytes reached the network, so this half can say the transaction exists and may still confirm on its own — which the default must not claim without it.',
    } satisfies Variant),
    recipients: forUser(
      (event) =>
        `${wasBroadcast(event.payload) ? 'withdrawal.stuck_sent' : 'withdrawal.stuck'}:${stuckWithdrawalIdOf(event)}`,
      (event) => ({
        withdrawalId: stuckWithdrawalIdOf(event),
        reason: str(event.payload, ['reason'], 'it has not confirmed within the expected time'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:settlement:withdrawal:${stuckWithdrawalIdOf(event)}`,
    ),
  }),

  /**
   * A withdrawal that ended without reaching the chain — **and where the money went.**
   *
   * ## Why this rule was refused, and what changed
   *
   * `NON_NOTIFYING_TOPICS` carried this topic with the note that its envelope "names nobody notify
   * could address", and `UNPRODUCED_NOTIFICATIONS` carried the matching record. Both were right:
   * the payload was `{ withdrawalId, reason, refundable }`, `failedEvents` sets no actor (so this
   * service's relay stamps `service:settlement`), and the registry keys the topic by
   * `withdrawal_id` — which is a uuid, so a key fallback would have handed back a withdrawal id as
   * a user id. Well-formed, queryable and wrong. A rule then would have answered `no_recipient`
   * for ever, and a rule that resolves nobody is worse than a written-down gap, because the
   * coverage test counts it.
   *
   * `settlement/src/withdrawals.ts` now sends `userId` — the same value `stuckEvents` already
   * sent off the same row — so `forUser` resolves a recipient here exactly as it does on
   * `settlement.withdrawal.stuck`. Note what settlement did **not** do: it did not mint
   * `settlement.withdrawal.failed`. Its reasoning is on `failedEvents` and it is right — `completed`
   * has a twin because the two carry different payloads for different readers, whereas a `.failed`
   * twin would be one fact under two official names keyed identically, which is the
   * `settlement.outbound.stuck` proposal micro-contracts already refused. What was missing was the
   * recipient, not the topic.
   *
   * ## Two facts, and `refundable` decides which
   *
   * "Your withdrawal failed and the money is coming back" and "your withdrawal failed and your
   * money is held" are different news, and micro-activity classified them as two entries
   * (`withdrawal.failed_refunded` / `withdrawal.failed_held`, activity/src/classify.ts) for
   * exactly this reason. So this rule has a `variant` rather than one hedged sentence, and the
   * templates keep activity's names so the feed entry and the notification a user reads on the
   * same screen cannot say opposite things.
   *
   * ## The held case is `critical`, and the refunded case is not
   *
   * §10.3's critical list names **withdrawal**, so neither of these is a promotion beyond it; the
   * question is only which of the two a user may be allowed to mute. The held case may not be, on
   * one fact: **nothing else in the estate will ever tell them.** Trace it. wallet's non-refundable
   * branch (`wallet/src/withdrawals.ts`) moves the row to `stuck` and emits nothing at all —
   * the only `wallet.withdrawal.stuck` emit is the deadline sweep, and that topic is in
   * no registry anyway. `settlement.withdrawal.stuck` does not fire, because a failure is not a
   * late transaction. `ledger.entry.posted` does not fire either: nothing is posted, and notify's
   * rule for it requires a `user_id` the ledger payload has never carried. The user's balance shows
   * an amount reserved against a payment that will never be made, the destination shows nothing
   * arrived, and the only account of it is this notification. A `min_priority` of `critical` on the
   * withdrawal category, or that category switched off, would turn "your money is stuck" into
   * silence — which is the exact substitution §10.3's invariant exists to forbid.
   *
   * The refunded case is `high`, beside `completed` and `stuck`. The money is back and spendable,
   * so the balance itself is a second, independent account of the fact; the user's next action is
   * "try again", not "find out where my money is"; and every unnecessary `critical` is a
   * preference page that quietly stops working (see this file's header). `high` is prompt and
   * muteable, which is what recoverable news should be.
   *
   * ## The dedupe key names the disposition, not just the withdrawal
   *
   * Two reasons. `settlement.withdrawal.stuck` already keys `withdrawal.failed:<id>`, and a
   * withdrawal that went late and then failed must produce both — the second is the outcome of the
   * first, and collapsing them would mean the user hears "it is late" and never hears how it
   * ended. And if a held failure were ever corrected to a refunded one, the correction is the most
   * important message in the sequence and must not dedupe into the thing it corrects. Literal
   * redelivery is handled where it belongs, by the inbox unique on `(topic, event_id)`.
   */
  'settlement.outbound.failed': Object.freeze({
    category: 'withdrawal',
    // The default, and the reading an absent `refundable` gets. See `refunded`.
    priority: 'critical',
    templateId: 'withdrawal.failed_held',
    why: 'A withdrawal ended with the money neither at its destination nor back in the balance, and no other event in the estate says so — wallet moves the row to stuck and emits nothing. Silence here is a user whose funds have vanished from their own view.',
    variant: Object.freeze({
      when: (event) => refunded(event.payload),
      priority: 'high',
      templateId: 'withdrawal.failed_refunded',
      why: 'The money is coming back, so the balance is a second account of the fact and the action is "try again". Prompt, and muteable — a critical set that grows past what a user must never be able to silence is a preference page that stops working.',
    } satisfies Variant),
    recipients: forUser(
      (event) =>
        `${refunded(event.payload) ? 'withdrawal.failed_refunded' : 'withdrawal.failed_held'}:${withdrawalIdOf(event)}`,
      (event) => ({
        withdrawalId: withdrawalIdOf(event),
        reason: str(event.payload, ['reason'], 'it could not be sent'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:settlement:withdrawal:${withdrawalIdOf(event)}`,
    ),
  }),

  'ledger.entry.posted': Object.freeze({
    category: 'transfer',
    priority: 'low',
    templateId: 'transfer.posted',
    why: 'The complete record of balance movement. Low priority and digestible by default — a user who wants every posting can ask for it, and one who does not must not be buried.',
    recipients: forUser(
      (event) => `transfer.posted:${str(event.payload, ['entry_id', 'entryId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], ''),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        description: str(event.payload, ['description', 'kind'], 'a balance movement'),
      }),
      (event) => `cf:ledger:entry:${str(event.payload, ['entry_id', 'entryId'], event.id)}`,
      // A posting with no user attribution is an internal or treasury movement.
      (event) => Boolean(str(event.payload, ['user_id', 'userId'], '')),
    ),
  }),

  /* --------------------------------------------------------- products
   *
   * The three rules below are keyed to topics the shared registry does not name YET, and that is a
   * declared state rather than an accident: each is quarantined in `topics.ts` with the exact
   * `TopicSpec` that registers it and the emit site that proves the producer sends it, and
   * `topics.test.ts` fails the moment contracts adopts one and the quarantine entry is not deleted.
   * `events.ts` accepts a well-formed envelope on an unregistered topic precisely when a rule
   * exists, which is what makes them live today rather than one contracts release from now.
   *
   * Each replaces a RECORD that said the notification was impossible. It was not: the producer had
   * been emitting all along under the name notify itself had written down. See the header of
   * `topics.ts` for why a record could say that and no check inside this repository could see it.
   */

  'trade.bot.paused': Object.freeze({
    category: 'trading',
    priority: 'high',
    templateId: 'trading.bot_paused',
    why: 'A bot stopping is the state its owner most needs to hear about, and pausing does not close the position — `pauseBot` in trade/src/bots.ts says so in its own words, "Pause is deliberately not a flatten. The position stays open by design", and leaves equity as "a mark-to-market number from whenever it last ticked". Silence here is a user who believes they are flat.',
    recipients: forUser(
      // Keyed on the BOT, not the event: a bot paused and resumed and paused again in a minute is
      // one piece of news, and `event.id` would dedupe nothing.
      (event) => `trading.bot_paused:${str(event.payload, ['bot_id', 'botId'], event.key)}`,
      (event) => ({
        botLabel: str(event.payload, ['bot_name', 'botName', 'name', 'bot_id', 'botId'], 'Your trading bot'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:trade:bot:${str(event.payload, ['bot_id', 'botId'], event.key)}`,
    ),
  }),

  /* --------------------------------------------------------- trade's other six. micro-org#345
   *
   * Six topics arrived at once and TWO of them got rules. The split is not "how important is
   * trading" — it is the question this catalogue asks of everything: **is the reader somewhere
   * else when this happens, and is this the only thing that will tell them?**
   *
   *   - `trade.fee.settled`     — RULE. The platform takes money on its own initiative, from a
   *                               customer who is not watching. Nothing else says so.
   *   - `trade.transfer.settled`— RULE. It settles asynchronously, after the user has left the
   *                               screen they started it from.
   *   - `trade.bot.created`     — no. The user is looking at the bot they just made.
   *   - `trade.bot.started`     — no. Same, and `trade.bot.paused` above is the half that is news.
   *   - `trade.fill.settled`    — no. Per-fill mail is the worst noise source a bot could have.
   *   - `trade.order.filled`    — no. The terminal shows fills live, as they happen.
   *
   * Each of the four is written out in `NON_NOTIFYING_TOPICS` at the length of a decision, because
   * a topic that is silently absent from this table and a topic somebody decided against are
   * indistinguishable a year later.
   */

  /**
   * **THE PLATFORM CHARGING THE CUSTOMER**, which is the only trade event with that shape.
   *
   * Every other rule in this block, and both of the API-key rules below it, tells somebody about
   * something they or an attacker did. This one tells them about something CLOUDSFORGE did to
   * their balance while they were not looking: `settleFee` runs on trade's own settlement path,
   * not on a request, and the fee is deducted whether or not anyone is on the screen. `high` for
   * the reason `billing` is: money leaving an account on the platform's initiative is worth an
   * interruption, and a customer who finds out from a balance is a customer who opens a ticket.
   *
   * **Not `critical`.** §10.3's list is the set a user must never be able to silence, and it is
   * about security and about money that has gone MISSING. A fee that was correctly charged and is
   * fully explained on the settlement history does not belong in a set whose value comes from
   * being small — the argument `withdrawal.failed_refunded` makes for stepping down from it.
   *
   * **The recipient is the ENVELOPE ACTOR, and here that is safe rather than merely convenient.**
   * `settleFee` builds it from the BOT ROW's own `userId` column, not from a caller — so it is the
   * owner whatever reached the emit, which is a property of the producer rather than an
   * observation about who usually acts. `activity` reads the same field for the same reason and
   * quarantines the reader to the same topics. `userIdOf`'s actor branch is the last resort it
   * describes; it is reached here because the payload — `{ settlementId, botId, period, collected,
   * due, status, entryId }` — names nobody, and the key is the SETTLEMENT, a uuid that is not a
   * person.
   *
   * **Keyed on the settlement, not the bot and not the event.** One fee settlement is one charge;
   * a redelivery is the same charge, and next period's fee on the same bot is a different one.
   *
   * **The variant is a SECOND FACT, and the dedupe key deliberately does not name it.** That is
   * where this rule parts company with the two variants above it. `settlement.outbound.failed`
   * puts the disposition in its key because a held failure can be corrected to a refunded one and
   * the correction must not dedupe into the thing it corrects, and `trade.transfer.settled` puts
   * the direction in its key because a deposit and a withdrawal are two different transfers that
   * happen to share a topic. Neither applies here: `settle` resolves a settlement row once, writes
   * its `status` in the same statement it emits from, and never re-opens it — the uncollected
   * remainder is billed on a NEW row, in a new period, with a settlement id of its own. So one
   * settlement id cannot produce both sentences, the key stays `trading.fee_charged:<settlementId>`
   * whichever is chosen, and a redelivery still collapses into the one charge it describes.
   */
  'trade.fee.settled': Object.freeze({
    category: 'trading',
    priority: 'high',
    templateId: 'trading.fee_charged',
    why: 'The platform taking money out of a balance on its own initiative, from a user who is not on the screen — settleFee runs on trade\'s settlement path rather than on a request. Nothing else in the estate reports it, so silence here is a customer who discovers a charge by noticing a smaller number.',
    variant: Object.freeze({
      when: (event) => isPartialCollection(event.payload),
      // HIGH, the same as the full charge, and that is argued rather than inherited.
      //
      // Not `critical`. §10.3's list is enumerated by a test precisely so that it stays small, and
      // it is about security and about money that has gone MISSING; the shortfall here is money
      // that never left the balance. Putting this in the set a user may not silence would mean
      // they cannot silence the one thing this topic says that is LESS alarming than a full charge.
      //
      // Not `normal` either, which is the reading that was easy to reach for — less money moved,
      // so it matters less. It carries strictly more news than the full charge: the same
      // unannounced deduction, plus a balance that could not cover it, plus an amount the platform
      // is still going to take. `normal` is digestible by default, so the only message in the
      // estate that tells a customer they owe something would arrive in a batch the next day.
      priority: 'high',
      templateId: 'trading.fee_charged_partial',
      why: 'A fee that was paid in full is finished business and a fee that was partly paid is not: trade carries the shortfall on the bot as feeOwed and adds it to the next settlement\'s due, so "a performance fee was charged" tells the reader the opposite of what happened to them. The same priority as the full charge, deliberately — it is that same unannounced deduction PLUS a debt, so it cannot be the quieter of the two, and it is neither a security event nor money gone missing, so it must not join the critical set §10.3 keeps small.',
    } satisfies Variant),
    recipients: forUser(
      // The template id in this key is a constant and not `outcomeOf`'s answer, unlike the
      // transfer rule below. See the block comment: one settlement resolves once, so the two
      // sentences are alternatives for different settlements rather than two facts about one.
      (event) => `trading.fee_charged:${str(event.payload, ['settlement_id', 'settlementId'], event.key)}`,
      (event) => ({
        botLabel: str(event.payload, ['bot_name', 'botName', 'name', 'bot_id', 'botId'], 'your trading bot'),
        // The period counter trade numbers a bot's settlements by, which is the handle a support
        // conversation uses. `str` treats an empty string as absent, so a missing one degrades to
        // the phrase rather than rendering "for period ".
        period: str(event.payload, ['period'], 'the period just settled'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:trade:bot:${str(event.payload, ['bot_id', 'botId'], '')}`,
    ),
  }),

  /**
   * Money crossing the boundary between a wallet balance and an exchange balance.
   *
   * **The rule exists because the settlement is ASYNCHRONOUS.** `settleTransfer` claims a row that
   * is `pending` or `unresolved` and settles it against the ledger afterwards, which is a different
   * moment from the one the user pressed the button in — they have left the screen, and a transfer
   * that has not landed and a transfer that has look identical from where they are standing. That
   * is the same test `wallet.deposit_address.assigned` FAILS ("the user is looking at it") and the
   * one `settlement.withdrawal.completed` passes.
   *
   * **Two facts, and `direction` decides.** A deposit ends with money that can be traded and a
   * withdrawal ends with money back in a wallet balance; they are not one sentence with a different
   * noun, and the two templates point at two different screens because the money is in two
   * different places. `activity` splits the same event the same way, so the feed row and the mail a
   * user reads on one screen cannot say opposite things.
   *
   * **`normal`, not `high`.** This is the confirmation of something that worked, which the reader
   * asked for and expects — the `withdrawal.completed` shape. `high` is for the ones that are wrong
   * or that nobody asked for.
   *
   * **No amount, and the asset instead.** `settleTransfer` sends `amount` in base units off a
   * `numeric(78,0)` column, so its scale is `chainSpec(asset).decimals` and no service downstream
   * of trade may look that up. See the templates.
   */
  'trade.transfer.settled': Object.freeze({
    category: 'transfer',
    // The default is the deposit, because it is the direction that leaves money somewhere new.
    priority: 'normal',
    templateId: 'transfer.exchange_deposit',
    why: 'A transfer between a wallet balance and an exchange balance settles asynchronously, after the user has left the screen they started it from, and nothing else tells them it landed. Normal rather than high: it is the confirmation of something they asked for and that worked.',
    variant: Object.freeze({
      when: (event) => isWithdrawalFrom(event.payload),
      priority: 'normal',
      templateId: 'transfer.exchange_withdrawal',
      why: 'The money ends somewhere else, so the sentence and the LINK are both different: a deposit points at the trading balances and a withdrawal at the wallet. One template covering both would have to hedge about where the money now is, which is the only thing the reader opened it for.',
    } satisfies Variant),
    recipients: forUser(
      // Keyed on the transfer, which is the fact. A redelivery is the same transfer; two transfers
      // of the same asset in a minute are two, and `event.id` would dedupe neither correctly.
      (event) =>
        `${isWithdrawalFrom(event.payload) ? 'transfer.exchange_withdrawal' : 'transfer.exchange_deposit'}:${str(event.payload, ['transfer_id', 'transferId'], event.key)}`,
      (event) => ({
        // `asset`, which is trade's spelling; the other two are read because a producer's field
        // name is not this service's to assume, and `ledger.entry.posted` above reads all three.
        // Empty rather than a stand-in word, as every other asset-bearing rule in this file does:
        // a sentence with a gap in it degrades honestly, and a guessed unit does not.
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:trade:transfer:${str(event.payload, ['transfer_id', 'transferId'], event.key)}`,
    ),
  }),

  /*
   * The two API-key rules address the ENVELOPE ACTOR, and that is the whole of why they work.
   *
   * The payload names the key and the project, never a user — `emitKeyIssued` and `emitKeyRevoked`
   * in `devplatform/src/apikeys.ts` send `{ keyId, projectId, environment, display, … }` and no
   * owner — and notify holds no project-membership table it could look one up in. `actorOf` makes
   * the actor `user:<id>` for a caller holding a session, and in the case these rules exist for — a
   * stolen session — that id IS the victim's, because the attacker is acting as them. So the
   * notification lands in the real owner's inbox: the `identity.session.created` model.
   *
   * ── THIS COMMENT PREDICTED TWO PRODUCER DEFECTS. BOTH WERE REAL, AND BOTH ARE NOW FIXED. ────
   *
   * It used to name two actor spellings devplatform emitted, `key:<display>` for an API-key caller
   * and `system:identity` on the organisation-erasure path, and call them "a producer to fix". They
   * were worse than this comment guessed: neither is a legal `Actor` at all. `ActorKind` is
   * `user | service | operator | system`, `system` is the one kind that takes NO subject, so
   * `parseActor` refuses both — every envelope on either path was one the estate rejects outright.
   * devplatform has since corrected them to `service:<display>` and `service:identity`.
   *
   * Two lessons are worth more than the citations were, and both are asserted rather than asserted
   * about — see `topics.test.ts`, `the two illegal actor spellings can never come back`:
   *
   *   1. **The prediction is now a property of the CONTRACT, not of another repository's line
   *      numbers.** The version of this note that cited `server.ts` and was stale within
   *      the hour those defects were fixed, which is how a `path:line` claim always ends. What
   *      cannot go stale is `parseActor` refusing `key:` and `system:<anything>`, and that is
   *      checkable in this repository's CI, which checks out `micro-contracts` and not
   *      `micro-devplatform`.
   *   2. **The defects were invisible because a CONSUMER excused them.** `activity` quarantined
   *      unregistered topics without validating their envelopes, so an illegal actor on an
   *      unregistered topic was stored rather than refused. Registration removed that shelter.
   *      A quarantine that forgives more than the one fact it is for hides producer bugs until a
   *      release somewhere else exposes them all at once.
   *
   * ── WHAT IS STILL TRUE, AND THE GAP THAT DID NOT CLOSE ──────────────────────────────────────
   *
   * `forUser` still answers `no_recipient` for a `service:` actor, and that is CORRECT and must
   * stay: a key minting a key is no person's news, and guessing would tell the wrong person that
   * their credentials changed. What changed is why — it is now the right answer to a legal
   * envelope, not the visible symptom of a broken one.
   *
   * The consequence is a live gap rather than a resolved one. The erasure path revokes EVERY live
   * key an organisation holds, as `service:identity`, and nobody is told: no user is on that
   * envelope, and neither this service nor `activity` may read a database to find one. `activity`
   * files it as `api.key_revoked_by_platform`, internal — an operator's record and nobody's
   * notification. The repair is one field from devplatform (`api_keys.created_by` is on the row
   * `revokeOrgKeys` already updates), and it is filed for micro-devplatform, not worked around here.
   */

  'devplatform.key.issued': Object.freeze({
    category: 'api',
    priority: 'high',
    templateId: 'api.key_issued',
    why: 'An API key acts as the user, without a password and without a second factor, so a key created by somebody else is the first thing a compromise looks like — and nothing tells the account holder today.',
    recipients: forUser(
      (event) => `api.key_issued:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
      (event) => ({
        // The display (`cfk_live_…`), which is safe in a log and is what a revocation quotes. The
        // key itself never leaves devplatform and must never appear here.
        keyDisplay: str(event.payload, ['display', 'key_display', 'keyDisplay'], 'a new key'),
        project: str(event.payload, ['project_id', 'projectId'], 'your project'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:devplatform:api_key:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
    ),
  }),

  'devplatform.key.revoked': Object.freeze({
    category: 'api',
    priority: 'high',
    templateId: 'api.key_revoked',
    why: 'A revocation the owner did not make is somebody else inside their project, and a revocation they DID make silently breaks every integration using it — both halves are worth an interruption.',
    recipients: forUser(
      (event) => `api.key_revoked:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
      (event) => ({
        keyDisplay: str(event.payload, ['display', 'key_display', 'keyDisplay'], 'a key'),
        project: str(event.payload, ['project_id', 'projectId'], 'your project'),
        at: formatInstant(event.occurredAt),
        reason: str(event.payload, ['reason'], 'no reason was recorded'),
      }),
      (event) => `cf:devplatform:api_key:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
    ),
  }),

  /**
   * Somebody offered on your listing — **and the recipient is the person who did not act.**
   *
   * ## The refusal that was right, and the one field that ended it
   *
   * This rule was refused for the life of the service and the refusal is recorded in `topics.ts`:
   * `market/src/bids.ts` emitted `{ listingId, offerId, offererSubject, amount, assetCode }` with
   * the OFFERER as the envelope actor, so every route this service has to a person — payload
   * `user_id`, the key, the `user:` actor — resolved the offerer. A rule then would have told the
   * offerer that their own offer arrived: noise, a false claim of AD-08 coverage, and a
   * notification about someone else's money sent to the wrong person.
   *
   * `market/src/bids.ts` now sends `sellerSubject`, read off the listing row the same
   * transaction already holds `for update`, so it is the seller **at the moment the offer was
   * made** rather than whoever owns the listing when a consumer gets round to reading it. Market's
   * own commit names this rule as the thing that closes its record.
   *
   * ## `forUser` is deliberately not used here
   *
   * `userIdOf` falls back to `actor` when it is `user:<id>`, and on this envelope that actor IS the
   * offerer. So the generic helper would resolve the wrong person on every event — the same trap as
   * `aetherholm.battle.resolved`, where the actor is the raider and the notification is the
   * defender's. The seller is read explicitly or there is no recipient.
   *
   * ## A subject is not a user id
   *
   * `sellerSubject` is `user:<uuid>` **or** `service:<name>`: a listing may be owned by a service
   * principal (`market/src/server.ts` takes the seller from `subjectOf(principal)`). Stripping
   * the prefix blindly would address a notification to a service name — a row keyed on a user id
   * that is not one. A non-`user:` seller is `not_applicable`: the rule looked at it and decided a
   * service principal is not a person to interrupt, which is a different fact from "the producer
   * did not say who", and the two must not collapse into one metric.
   */
  'market.offer.made': Object.freeze({
    category: 'market',
    priority: 'normal',
    templateId: 'market.offer_received',
    why: 'A seller with an offer nobody told them about is a sale that does not happen. The offer holds the buyer\'s money in escrow while it waits, so silence costs both sides.',
    recipients: (event: InboundEvent): RecipientSet => {
      // `userOfSubject` rather than a slice, and its comment carries the argument. This rule was
      // where that branch was first written; it is shared now because tessera needed the identical
      // three-way answer and a security-relevant branch copied four times is a branch that will
      // eventually differ in one copy.
      const seller = userOfSubject(str(event.payload, ['seller_subject', 'sellerSubject'], ''))
      if (seller.kind === 'none') return seller
      const userId = seller.userId
      const offerId = str(event.payload, ['offer_id', 'offerId'], event.id)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId,
            params: {
              amount: str(event.payload, ['amount'], 'An offer'),
              asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
              // The listing, because a seller with several needs to know which one.
              listingId: str(event.payload, ['listing_id', 'listingId'], event.key),
            },
            // Keyed on the OFFER, not the listing: a second offer on the same listing is a second
            // piece of news, and keying on the listing would silence every offer after the first.
            dedupeKey: `market.offer_received:${offerId}`,
            subjectUrn: `cf:market:listing:${str(event.payload, ['listing_id', 'listingId'], event.key)}`,
          },
        ],
      }
    },
  }),

  'market.listing.sold': Object.freeze({
    category: 'market',
    priority: 'high',
    templateId: 'market.sale',
    why: 'A sale is money in. The seller should not find out by checking.',
    recipients: forUser(
      (event) => `market.sale:${event.key}`,
      (event) => ({
        itemName: str(event.payload, ['item_name', 'itemName', 'title'], 'Your listing'),
        amount: str(event.payload, ['amount', 'price'], ''),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
      }),
      (event) => `cf:market:listing:${event.key}`,
    ),
  }),



  'mint.deploy.confirmed': Object.freeze({
    category: 'token',
    priority: 'high',
    templateId: 'token.deployed',
    why: 'This is the event that retires ForgeMint’s four-second client poll. The client can stop asking because it is told.',
    recipients: forUser(
      (event) => `token.deployed:${event.key}`,
      (event) => ({
        tokenName: str(event.payload, ['token_name', 'tokenName', 'name', 'symbol'], 'Your token'),
        address: str(event.payload, ['address', 'contract_address', 'contractAddress'], 'the deployed address'),
        chain: str(event.payload, ['chain', 'network'], 'the network'),
      }),
      (event) => `cf:mint:token:${event.key}`,
    ),
  }),

  'worlds.provision.failed': Object.freeze({
    category: 'billing',
    priority: 'high',
    templateId: 'provision.failed',
    why: 'Money was paid and the thing it bought was not delivered. That is the one game event a person must not discover by revisiting a screen.',
    // NOT forUser: the payload names the buyer as `subject` (worlds/src/provisioning.ts) and
    // the actor is `service:worlds`, so userIdOf would find nobody and the rule would silently
    // notify no one — the same shape as the raider/defender trap in aetherholm.battle.resolved.
    recipients: (event: InboundEvent): RecipientSet => {
      const subject = str(event.payload, ['subject'], '')
      if (!subject) return { kind: 'none', reason: 'no_recipient' }
      const entitlementId = str(event.payload, ['entitlement_id', 'entitlementId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: subject,
            params: { entitlementId },
            dedupeKey: `provision.failed:${entitlementId}`,
            subjectUrn: `cf:worlds:entitlement:${entitlementId}`,
          },
        ],
      }
    },
  }),
  /* --------------------------------------------------------- rewards, and their one unit
   *
   * Both rules below name what was earned through `rewardNameOf`, whose comment carries the whole
   * argument: what each producer really puts on the wire, why neither of them says which asset the
   * reward is in, and why that means no unit is written down here. It is shared rather than
   * duplicated because these two used to disagree — one appended "Shards", the other appended
   * nothing — and neither disagreement was a decision anybody made.
   */
  'emberkin.reward.granted': Object.freeze({
    category: 'reward',
    priority: 'normal',
    templateId: 'reward.granted',
    why: 'Same reasoning as worlds.reward.granted: a reward nobody was told about does not bring the player back.',
    recipients: forUser(
      (event) => `emberkin.reward:${str(event.payload, ['journalEntryId', 'journal_entry_id'], event.key)}`,
      (event) => ({
        rewardName: rewardNameOf(event.payload),
        // The title, spelled once, because this topic has exactly one producer and it is the
        // Emberkin service (`emberkin/src/seasons.ts`). A product name is neither a figure nor an
        // asset code, so it is not what `rewardNameOf` forbids — and reading it off a payload that
        // does not carry it would only produce a fallback that says less.
        titleName: 'Emberkin',
      }),
      () => 'cf:emberkin:reward',
    ),
  }),
  'worlds.reward.granted': Object.freeze({
    category: 'reward',
    priority: 'normal',
    templateId: 'reward.granted',
    why: 'A reward nobody was told about is a reward that does not bring the player back.',
    recipients: forUser(
      (event) => `reward.granted:${str(event.payload, ['reward_id', 'rewardId'], event.id)}`,
      (event) => ({
        rewardName: rewardNameOf(event.payload),
        // `title_name`/`titleName`/`title` are read and none of them is sent: `worlds/src/rewards.ts`
        // puts `titleId` on the event and nothing else about the title. So this is "a game" on
        // every real delivery today, and it is left that way deliberately — the alternative on
        // hand is `titleId`, and "You earned a reward in 0f6c…" names the row rather than the game.
        // Making it say the title's name is a change to the PRODUCER (put the name on the event),
        // not a lookup this consumer should grow; recorded here so the next reader does not
        // rediscover it by testing the fallback and finding it fires every time.
        titleName: str(event.payload, ['title_name', 'titleName', 'title'], 'a game'),
      }),
      (event) => `cf:worlds:reward:${str(event.payload, ['reward_id', 'rewardId'], event.id)}`,
    ),
  }),

  'community.proposal.opened': Object.freeze({
    category: 'community',
    priority: 'normal',
    templateId: 'community.proposal',
    why: 'A proposal a member never saw is a vote they could not cast.',
    recipients: (event: InboundEvent) => membersOf(event, 'open'),
  }),

  'community.proposal.executed': Object.freeze({
    category: 'community',
    priority: 'normal',
    templateId: 'community.proposal',
    why: 'A passed proposal cleared its timelock and spent the treasury. Members are entitled to know.',
    recipients: (event: InboundEvent) => membersOf(event, 'executed'),
  }),

  'community.vote.cast': Object.freeze({
    category: 'governance',
    priority: 'normal',
    templateId: 'governance.vote',
    why: 'A receipt. "Was my vote counted, and at what weight" must be answerable without support.',
    recipients: forUser(
      (event) => `governance.vote:${str(event.payload, ['proposal_id', 'proposalId'], event.key)}:${str(event.payload, ['user_id', 'userId'], event.id)}`,
      (event) => ({
        communityName: str(event.payload, ['community_name', 'communityName'], 'your community'),
        proposalTitle: str(event.payload, ['proposal_title', 'proposalTitle', 'title'], 'a proposal'),
        choice: str(event.payload, ['choice', 'vote'], 'recorded'),
        weight: str(event.payload, ['weight'], 'your holding at the snapshot block'),
      }),
      (event) => `cf:community:proposal:${str(event.payload, ['proposal_id', 'proposalId'], event.key)}`,
    ),
  }),



  'billing.entitlement.granted': Object.freeze({
    category: 'billing',
    priority: 'normal',
    templateId: 'billing.entitlement_granted',
    why: 'Someone bought something. The estate’s named defect is the private world that is paid for and never built; this is the user-facing half of noticing.',
    recipients: forUser(
      (event) => `billing.entitlement_granted:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
      (event) => ({ productName: str(event.payload, ['product_name', 'productName', 'product'], 'Your purchase') }),
      (event) => `cf:billing:entitlement:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
    ),
  }),

  'billing.entitlement.revoked': Object.freeze({
    category: 'billing',
    priority: 'high',
    templateId: 'billing.entitlement_revoked',
    why: 'Access ending without warning looks like a fault. Saying why turns a support ticket into a renewal.',
    recipients: forUser(
      (event) => `billing.entitlement_revoked:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
      (event) => ({
        productName: str(event.payload, ['product_name', 'productName', 'product'], 'a product'),
        reason: str(event.payload, ['reason'], 'the subscription ended'),
      }),
      (event) => `cf:billing:entitlement:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
    ),
  }),

  /* --------------------------------------------------------- aetherholm */

  'aetherholm.battle.resolved': Object.freeze({
    category: 'ownership',
    priority: 'high',
    templateId: 'ownership.battle_report',
    why: '"Your city was raided" is exactly what this channel exists for: it happened while the player was away, it cost them something, and the one action — look at the report, rebuild, retaliate — is theirs to take.',
    // NOT forUser: its userIdOf falls back to the envelope ACTOR, and this event's actor is the
    // ATTACKER (aetherholm/src/fleets.ts, `user:` actor on the emit). The payload names both
    // sides; the recipient is the DEFENDER, read explicitly or not at all.
    recipients: (event: InboundEvent): RecipientSet => {
      const defender = str(event.payload, ['defender_user_id', 'defenderUserId'], '')
      if (!defender) return { kind: 'none', reason: 'no_recipient' }
      const battleId = str(event.payload, ['battle_id', 'battleId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: defender,
            params: {
              cityName: str(event.payload, ['city_name', 'cityName'], 'your city'),
              outcome: str(event.payload, ['outcome'], 'resolved'),
              at: formatInstant(event.occurredAt),
            },
            // One battle, one notification — however many times the event is redelivered.
            dedupeKey: `aetherholm.battle:${battleId}`,
            subjectUrn: `cf:aetherholm:battle:${battleId}`,
          },
        ],
      }
    },
  }),

  'aetherholm.spire.captured': Object.freeze({
    category: 'reward',
    priority: 'normal',
    templateId: 'reward.heraldry',
    why: 'A 120-day campaign ended with this player on the objective, and the heraldry outlives the world it was won in. Once per season is the opposite of noise.',
    // The producer carries every member of the holding alliance on the payload (the community
    // events precedent, membersOf above): notify holds no membership table and must not guess.
    recipients: (event: InboundEvent): RecipientSet => {
      const raw = event.payload['user_ids'] ?? event.payload['userIds']
      const ids = Array.isArray(raw)
        ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      const seasonId = str(event.payload, ['season_id', 'seasonId'], event.id)
      const islandId = str(event.payload, ['island_id', 'islandId'], event.key)
      const params = { seasonName: str(event.payload, ['season_name', 'seasonName'], 'the season') }
      const recipients = ids.map((userId) => ({
        userId,
        params,
        dedupeKey: `aetherholm.spire:${seasonId}:${islandId}`,
        subjectUrn: `cf:aetherholm:island:${islandId}`,
      }))
      const [first, ...rest] = recipients
      if (!first) return { kind: 'none', reason: 'no_recipient' }
      return { kind: 'recipients', recipients: [first, ...rest] }
    },
  }),

  /* --------------------------------------------------------- tessera
   *
   * Seven topics were registered at once (`micro-contracts` 41751b1), so seven decisions were
   * taken at once, and each was taken by asking the SAME question that found `market.offer.made`:
   * **does this envelope name only the person who acted?**
   *
   * Three answers came back, and the third has since been closed by the producer:
   *
   *   - Three name somebody who is not the actor, or an actor who has genuinely left. Those were
   *     the first three rules below.
   *   - Two name the actor and nobody else because there is nobody else — the reader did the thing
   *     on purpose and is looking at the result, or the fact has no individual subject at all.
   *     `NON_NOTIFYING_TOPICS`, and they are still there.
   *   - **Two named only the actor while the news belonged to somebody they had never met.** Those
   *     got no rule, because a rule would have answered `no_recipient` for ever or addressed the
   *     wrong person, and they were recorded in `topics.ts`'s `UNPRODUCED_NOTIFICATIONS` as
   *     `no-subject` against `micro-tessera` — the same shape and the same repair as market's offer.
   *
   * **Both of those two are rules now, and this is the third time that repair has run.** tessera
   * `33ead39` puts `ownerSubject` on both payloads, read from `select owner_subject, ward_id from
   * parcels where id = … for update` taken BEFORE the insert, in the lock order `moveParcel` uses.
   * `settlement.outbound.failed` and `market.offer.made` closed the same way, which is three for
   * three: every `no-subject` record this service has ever written has been closed by the producer
   * adding one field off a row its emitting transaction already held, and none of them was closed
   * by this service guessing. That is the argument for writing the record instead of the rule.
   *
   * One thing about the guarantee is worth carrying, because it is NOT the same as the market
   * precedent. `market.listing.removed` had to read `refundedSubjects` before the releases because
   * afterwards the rows leave `state='held'` and the information is gone. Neither tessera function
   * mutates `parcels`, so the owner is never erased and the `for update` is a LOCK constraint
   * rather than an information-destruction one — it is there so a transfer committing alongside
   * cannot make `venue.booked` tell the FORMER owner they are owed money. Either way the subject on
   * the envelope is authoritative as at emit time, and these two rules are written on that.
   */

  'tessera.object.fired': Object.freeze({
    category: 'ownership',
    priority: 'normal',
    templateId: 'tessera.object_fired',
    why: 'A firing is queued work, not a click. `tessera/src/kiln.ts` beginFiring "returns immediately with a `firing` row; the job does the work", and the job leases on `owner:<subject>` (jobs.ts, KILN_FIRE_KIND) so ONE PLAYER\'S FIRINGS SERIALISE — a player who queues five waits through all five. That is the condition worlds.provision.completed wrote down as the thing that would earn a rule ("if provisioning ever becomes slow enough to leave"), met on arrival rather than later.',
    // The actor here IS the author (`user:${authorSubject.slice(...)}` at the emit), so `forUser`
    // would work today. It is still not used: the author is a payload FIELD and the actor is an
    // accident of who happened to trigger the job, and `tessera.object.anchored` below proves the
    // point by emitting the same fact with `actor: 'system'`. Two sibling topics resolved two
    // different ways is how one of them silently becomes wrong.
    recipients: (event: InboundEvent): RecipientSet => {
      const author = userOfSubject(str(event.payload, ['author_subject', 'authorSubject'], ''))
      if (author.kind === 'none') return author
      const objectId = str(event.payload, ['object_id', 'objectId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: author.userId,
            params: {
              objectCategory: str(event.payload, ['category'], 'object'),
              checksum: str(event.payload, ['checksum'], ''),
            },
            // The object, not the event: a redelivery of one firing is one piece of news. Not the
            // checksum — two identical objects fired by two people share one, and `completeFiring`
            // marks the second a duplicate rather than a separate firing.
            dedupeKey: `tessera.object_fired:${objectId}`,
            subjectUrn: `cf:tessera:object:${objectId}`,
          },
        ],
      }
    },
  }),

  'tessera.object.anchored': Object.freeze({
    category: 'ownership',
    priority: 'normal',
    templateId: 'tessera.object_anchored',
    why: 'An on-chain anchor confirms in a block, on a timescale nobody watches, and it is the point at which authorship becomes provable without this platform. The author asked for it and left.',
    // **`forUser` is impossible here, not merely unwise.** The emit sets `actor: 'system'`
    // (tessera/src/kiln.ts, the ANCHORED emit), the registry keys this topic by `object_id` rather
    // than `user_id`, and the payload carries no `user_id` — so all three of `userIdOf`'s routes
    // miss and it returns null. The rule would have resolved nobody, for ever, while the coverage
    // test counted it. `authorSubject` is read explicitly, and tessera's own emit comment says why
    // it is there: "the audit table's subjectKind: 'user' reads THIS field, not the envelope key".
    recipients: (event: InboundEvent): RecipientSet => {
      const author = userOfSubject(str(event.payload, ['author_subject', 'authorSubject'], ''))
      if (author.kind === 'none') return author
      const objectId = str(event.payload, ['object_id', 'objectId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: author.userId,
            params: {
              transactionHash: str(event.payload, ['transaction_hash', 'transactionHash'], ''),
              blockNumber: str(event.payload, ['block_number', 'blockNumber'], ''),
            },
            dedupeKey: `tessera.object_anchored:${objectId}`,
            subjectUrn: `cf:tessera:object:${objectId}`,
          },
        ],
      }
    },
  }),

  'tessera.parcel.transferred': Object.freeze({
    category: 'ownership',
    priority: 'high',
    templateId: 'tessera.parcel_lost',
    why: 'A contest takes ground off its owner while they are not there — that is the entire premise: a parcel is only contestable after 90 days fallow plus 30. The loser did nothing, is told by nothing else, and finds out by opening Tessera and looking for land that is gone.',
    // Two subjects on the payload and only ONE of them is notified, which is a decision rather than
    // an oversight:
    //
    //   - `reason: 'contest'` — `resolveContest` emits with `actor: 'system'` and `fromSubject` is
    //     the dispossessed owner. Nobody acted on their behalf and nobody told them.
    //   - `reason: 'trade'` — both parties agreed to a transfer they are both looking at.
    //     `not_applicable`, on the emberkin.cosmetic.equipped precedent: confirming a thing two
    //     people just did on purpose is the noise that trains them to ignore this channel.
    //
    // The WINNER of a contest is not notified either, under both readings: they opened the contest,
    // they are waiting for it, and the 30-day clock was theirs to watch.
    recipients: (event: InboundEvent): RecipientSet => {
      if (str(event.payload, ['reason'], '') !== 'contest') {
        return { kind: 'none', reason: 'not_applicable' }
      }
      const loser = userOfSubject(str(event.payload, ['from_subject', 'fromSubject'], ''))
      if (loser.kind === 'none') return loser
      const parcelId = str(event.payload, ['parcel_id', 'parcelId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: loser.userId,
            params: {
              parcelId,
              wardId: str(event.payload, ['ward_id', 'wardId'], ''),
            },
            // The parcel and the loser together: one parcel can be lost, reclaimed and lost again,
            // and each loss is real news. Keying on the parcel alone would silence the second.
            dedupeKey: `tessera.parcel_lost:${parcelId}:${loser.userId}`,
            subjectUrn: `cf:tessera:parcel:${parcelId}`,
          },
        ],
      }
    },
  }),

  'tessera.parcel.fallowed': Object.freeze({
    category: 'ownership',
    priority: 'high',
    templateId: 'tessera.parcel_contested',
    why: "Somebody has opened a claim on ground this reader holds, and the reader is by construction not there: a contest is only insertable 90 days after the last visitor or edit plus 30 more, on the DATABASE clock (`tessera_assert_contest_window`). Nothing else in the estate tells them. `tessera.parcel.transferred` is the same news arriving after it is too late to matter, and this is the only one that arrives while it is still a warning.",
    // **`ownerSubject`, and emphatically not `forUser`.** The actor on this envelope is
    // `user:<challenger>` (tessera/src/world.ts, `openContest`) and the key is the parcel, so BOTH
    // of `userIdOf`'s fallbacks resolve somebody who must not be told: one a stranger who would be
    // congratulated on a contest they already know they opened, the other a parcel id worn as a
    // user id. The owner is a payload FIELD, exactly as `authorSubject` is on `object.anchored`,
    // and `userOfSubject` rather than a slice because a parcel may be held by a service principal.
    recipients: (event: InboundEvent): RecipientSet => {
      const owner = userOfSubject(str(event.payload, ['owner_subject', 'ownerSubject'], ''))
      if (owner.kind === 'none') return owner
      const parcelId = str(event.payload, ['parcel_id', 'parcelId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: owner.userId,
            params: {
              parcelId,
              wardId: str(event.payload, ['ward_id', 'wardId'], ''),
            },
            // The CONTEST, not the parcel: `contests_status_known` allows `withdrawn`, so one
            // parcel can be contested, released and contested again, and each is real news —
            // `tessera.parcel_lost` makes the same argument about the same parcel.
            //
            // The fallback is the PARCEL rather than `event.id`. `tessera_one_open_contest` is a
            // partial unique index on `(parcel_id) where status = 'open'`, so at most one contest
            // on a parcel is open at a time and the parcel identifies it; `event.id` differs on
            // every delivery and would dedupe nothing at all, which is the worse degradation.
            dedupeKey: `tessera.parcel_contested:${str(event.payload, ['contest_id', 'contestId'], parcelId)}`,
            subjectUrn: `cf:tessera:parcel:${parcelId}`,
          },
        ],
      }
    },
  }),

  'tessera.venue.booked': Object.freeze({
    category: 'ownership',
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // `high`, AND THE ARGUMENT FOR NOT MAKING IT `critical` IS THE POINT.
    //
    // This is money owed and a date somebody else has put in the reader's diary, which is
    // `market.listing.sold` — "A sale is money in. The seller should not find out by checking." —
    // with a deadline attached. `high` is what that topic takes and this one is not lesser news.
    //
    // It is not `critical`, for two separate reasons that would each be sufficient:
    //
    //   1. Nothing is at risk if a preference silences it. The failed-withdrawal precedent earned
    //      `critical` because the money was HELD and no other topic in the estate would ever say
    //      so; here the fee is escrowed in a ledger reservation that `bookings_open_holds_money`
    //      (tessera/src/migrations.ts, the bookings CHECK) makes non-optional, and the booking is
    //      on the parcel's own calendar. A suppressed notification costs a heads-up, not funds.
    //   2. `critical` is exactly 04-domain-model §10.3's five, enumerated by a test. Adding a sixth
    //      is a decision to WIDEN §10.3, not a priority choice — and every unnecessary critical is
    //      a preference page that stops working.
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    priority: 'high',
    templateId: 'tessera.venue_booked',
    why: "A stranger has taken an hour of the reader's calendar and escrowed a fee against it, and the reader did nothing to cause either. The booker is looking at their own confirmation; the owner is not looking at anything, because a Venue is booked without asking them. Silence here costs an owner who does not turn up and a booker who paid for a room nobody opened.",
    // The same `ownerSubject`/not-`forUser` argument as `parcel.fallowed` above, and the stakes are
    // higher by exactly one field: the actor is `user:<bookedBy>`, so a rule that took the actor
    // would tell the BOOKER they are owed money for their own booking.
    recipients: (event: InboundEvent): RecipientSet => {
      const owner = userOfSubject(str(event.payload, ['owner_subject', 'ownerSubject'], ''))
      if (owner.kind === 'none') return owner
      const parcelId = str(event.payload, ['parcel_id', 'parcelId'], event.key)
      const slot = str(event.payload, ['slot'], '')
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: owner.userId,
            params: {
              parcelId,
              // `formatInstant` passes an unparseable value through unchanged, so the fallback is
              // a sentence rather than a blank where the date should be.
              slot: formatInstant(slot || 'a time shown on the parcel calendar'),
              // ─────────────────────────────────────────────────────────────────────────────────
              // `priceWei` IS ON THE PAYLOAD AND IS DELIBERATELY NOT IN THE WORDS.
              //
              // It is an integer count of the smallest unit — `tessera_booking_price_whole_sparks`
              // constrains it to a whole multiple of `WEI_PER_SPARK`, which is 10^12 — so the
              // amount a person would recognise is `priceWei / WEI_PER_SPARK` Sparks. That divisor
              // lives in `tessera/src/sparks.ts` and is exported by no shared package, so notify
              // could only obtain it by keeping a second copy of a denomination. A copy that drifts
              // states the wrong amount of money in a sentence about money, which is worse than
              // stating none; and rendering the raw integer reads as either a bug or a fortune.
              //
              // So the template says the fee is escrowed and points at the parcel, where the figure
              // is shown with its unit. What would change this: `priceSparks` on the payload, or
              // the denomination exported from `@cloudsforge/contracts-*`. Not a guess here.
              // ─────────────────────────────────────────────────────────────────────────────────
            },
            // The BOOKING: a Venue with two slots taken is two pieces of news, and keying on the
            // parcel would silence every booking after the first. The fallback is parcel-and-slot
            // rather than the parcel alone because that pair is precisely what the database uses to
            // identify an open booking (`tessera_one_open_booking`, unique on `(parcel_id, slot)
            // where status = 'open'`), so the degraded key is still the right one.
            dedupeKey: `tessera.venue_booked:${str(event.payload, ['booking_id', 'bookingId'], `${parcelId}:${slot}`)}`,
            subjectUrn: `cf:tessera:parcel:${parcelId}`,
          },
        ],
      }
    },
  }),

  /* --------------------------------------------------------- agora
   *
   * ONE rule for fourteen registered topics, and the thirteen it does not map are in
   * `NON_NOTIFYING_TOPICS` with the same argument written out one by one: agora keeps its own
   * notification table, decides for itself what is worth an email, and asks for exactly those by
   * emitting `agora.notification.mail_requested`. A rule on `agora.post.created` would mail every
   * follower of every post ever written; a rule on `agora.spark.created` would mail an author once
   * per like. The producer has already made this decision — including the preferences the reader
   * set — and this service's job is to deliver what it asked for, not to re-derive it from the raw
   * facts and get a different answer.
   */

  'agora.notification.mail_requested': Object.freeze({
    category: 'community',
    priority: 'low',
    templateId: 'agora.notification',
    why: 'The one topic in the square that is a REQUEST to mail somebody rather than a fact about the square. agora already applied the reader\'s own preferences (`email_prefs`, joined INNER so a voice who never opted in is not even considered), already waited out a fifteen-minute window so four replies are one mail, and already checked the notification is still unread at sweep time. Everything left to decide here is which words and how loud.',
    // `low` because a reply is not an interruption: it is waiting in a place the reader will go
    // back to anyway, and the square's own badge is the primary channel. The whole point of the
    // sweep's window is that this can be late.
    variant: Object.freeze({
      when: (event: InboundEvent) => str(event.payload, ['kind'], '') === 'moderation',
      priority: 'normal',
      templateId: 'agora.moderation',
      why: 'Every other kind is somebody talking to you; this one is the platform having taken something of yours down or suspended the account, and it is the only kind agora ever fills `detail` in for — the reason a moderator gave. A person whose post vanishes with no explanation concludes the product is broken rather than that they broke a rule, so this is not a louder reply, it is different news with a different template.',
    }),
    // NOT `forUser`, and the reason is the ACTOR: agora emits this with `actor: row.subject`, so
    // `userIdOf`'s last-resort branch would resolve the right person today and quietly resolve the
    // wrong one the day a sweep runs under a service principal — which is what a scheduled sweep
    // is. The subject is a payload FIELD here, put there deliberately (`sweepEmail` calls it "the
    // SUBJECT, not an email address"), and `userOfSubject` rather than a slice because `user:` is
    // one of four principal spellings and slicing the others produces a well-formed row filed
    // against nobody.
    recipients: (event: InboundEvent): RecipientSet => {
      const reader = userOfSubject(str(event.payload, ['subject'], ''))
      if (reader.kind === 'none') return reader
      const notificationId = str(event.payload, ['notification_id', 'notificationId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: reader.userId,
            params: {
              headline: agoraHeadline(event),
              // agora fills this in for `moderation` and for nothing else, so the fallback is
              // what the `agora.moderation` template renders if a future kind arrives with an
              // empty one. "No reason was recorded" is true and actionable; a blank is neither.
              detail: str(event.payload, ['detail'], 'No reason was recorded.'),
              // Absolute when agora knows its own origin, `/notifications` when it does not — and
              // `/notifications` is deliberately the HUB's notification centre rather than a
              // guessed agora hostname. See the `agora.notification` template for the whole
              // argument, and `Env.publicUrl` in micro-agora for who is allowed to answer it.
              url: str(event.payload, ['url'], '/notifications'),
            },
            // The NOTIFICATION, not the event: the sweep is bounded by a time window rather than
            // by a `notified_at` column, so a sweep that overlaps its predecessor can offer the
            // same still-unread notification twice. Keying on the row is what makes that one mail.
            dedupeKey: `agora.notification:${notificationId}`,
            subjectUrn: `cf:agora:notification:${notificationId}`,
          },
        ],
      }
    },
  }),

  /* --------------------------------------------------------- platform */

} satisfies Readonly<Record<string, Rule>>)

/**
 * What an agora notification is, in the words the square itself uses.
 *
 * Copied from `SENTENCE` in `agora-web/src/pages/notifications.tsx`, deliberately and in the same
 * past tense, because the mail and the row are the SAME notification: a reader who follows the link
 * must find the sentence they were just sent. Two spellings of one fact read as two facts.
 *
 * `Record<string, string>` rather than a union: `kind` is a string off a payload, notify does not
 * import agora's types, and a kind this table has never seen must degrade to a true sentence rather
 * than fail. `moderation` is absent on purpose — it is the variant's template and never reaches
 * this map.
 */
const AGORA_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  reply: 'replied to you',
  quote: 'quoted your post',
  echo: 'echoed your post',
  spark: 'sparked your post',
  mention: 'mentioned you',
  follow: 'followed you',
  follow_request: 'asked to follow you',
  follow_accepted: 'accepted your follow',
  whisper: 'whispered to you',
  circle_invite: 'invited you to a circle',
  circle_request: 'asked to join your circle',
  circle_accepted: 'let you into a circle',
})

/**
 * The one sentence an agora mail leads with: who did what.
 *
 * The handle is agora's, not identity's, and it arrives already resolved on the payload — this
 * service holds no voices and must not start. When it is absent the sentence falls back to
 * "Someone", which is the honest form for the two cases that produce it: an actor whose account
 * was erased between the notification and the sweep, and any future kind that has no actor at all.
 */
function agoraHeadline(event: InboundEvent): string {
  const kind = str(event.payload, ['kind'], '')
  const sentence = AGORA_SENTENCES[kind] ?? 'left something for you in the square'
  const handle = str(event.payload, ['actor_handle', 'actorHandle'], '')
  return handle ? `@${handle} ${sentence}` : `Someone ${sentence}`
}

/**
 * Community events name a community, not a user, and this service does not hold memberships.
 *
 * Rather than have notify grow a shadow copy of the membership table — which would be wrong the
 * moment somebody joins — the producer is expected to carry the affected user ids on the payload.
 * When it does not, the event produces nothing and is recorded as `no_recipient`, which is
 * visible and fixable, instead of being delivered to a guess.
 */
function membersOf(event: InboundEvent, status: string): RecipientSet {
  const raw = event.payload['user_ids'] ?? event.payload['userIds'] ?? event.payload['members']
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  const proposalId = str(event.payload, ['proposal_id', 'proposalId'], event.id)
  const params = {
    communityName: str(event.payload, ['community_name', 'communityName'], 'your community'),
    proposalTitle: str(event.payload, ['proposal_title', 'proposalTitle', 'title'], 'a proposal'),
    status,
  }
  const recipients = ids.map((userId) => ({
    userId,
    params,
    dedupeKey: `community.proposal:${proposalId}:${status}`,
    subjectUrn: `cf:community:proposal:${proposalId}`,
  }))
  const [first, ...rest] = recipients
  if (!first) return { kind: 'none', reason: 'no_recipient' }
  return { kind: 'recipients', recipients: [first, ...rest] }
}

export function ruleFor(topic: string): Rule | undefined {
  return Object.hasOwn(RULES, topic) ? RULES[topic] : undefined
}

export function hasRule(topic: string): boolean {
  return Object.hasOwn(RULES, topic)
}

export const MAPPED_TOPICS: readonly string[] = Object.freeze(Object.keys(RULES))

/**
 * Registered topics that deliberately produce no notification, and why.
 *
 * Kept as data rather than as an omission so that `catalogue.test.ts` can assert full coverage of
 * the registry. An unlisted, unmapped topic fails the build — which is the only way a topic added
 * to the shared registry gets *considered* by this service rather than silently ignored.
 */
export const NON_NOTIFYING_TOPICS: Readonly<Record<string, string>> = Object.freeze({
  'identity.user.deleted':
    'Erasure, not news. Handled by the pipeline as a deletion of everything this service holds for the user — see ERASURE_TOPICS. Sending a notification to an account being erased would be both useless and a data-retention problem.',
  // ── the three wallet topics that are answered NO, and why each is a decision ───────────────
  // Registered by micro-contracts, mapped by nothing, and the reason the suite was red on main
  // (micro-org #211). The other two — wallet.link.verified and wallet.link.revoked — have RULES
  // above, because nothing else in the estate tells a user their money gained a destination.
  'wallet.deposit_address.assigned':
    'The user is looking at it. An assignment happens because they asked for a deposit address, and the address is in the response they are reading; a rotation replaces one they are not using. The envelope is also keyed `chain:network:address` and actored `service:wallet` — `assignDepositAddress` in wallet/src/deposits.ts marks the previous assignment `rotated`, inserts the new one and emits `DEPOSIT_ADDRESS_ASSIGNED` from inside one `withOutbox`, so the rotation and the assignment are one act by the service — so this is the platform talking to itself about where funds land. A mail restating an address the reader already has on screen is how a user learns to ignore mail from us.',
  'wallet.withdrawal.refunded':
    'Already sent, by the service that knows WHY. settlement.outbound.failed carries `refundable` and its rule renders withdrawal.failed_refunded — "the amount is coming back" — from the same withdrawal id. wallet emits this when the reservation actually returns to the balance, which is the same withdrawal reaching the same user seconds later. A rule here is a second mail about one refund, and the dedupe key cannot save it because the two rules would have to agree on a key across two producers by accident. If the landing moment is judged worth its own message it belongs as a VARIANT of the settlement rule, not as a rule here.',
  'wallet.withdrawal.stuck':
    'Already sent, by settlement.withdrawal.stuck, whose rule is above and now renders withdrawal.stuck (or withdrawal.stuck_sent) off the same withdrawal id. Two services detect one stuck withdrawal from either end — wallet because settlement has said nothing before the deadline (`sweepStuck` in wallet/src/withdrawals.ts, whose own comment is that the deadline "is how long settlement is allowed to take before \'in progress\' stops being a plausible explanation"), settlement because its own outbound has not confirmed — and one stuck withdrawal is one fact to the person waiting for the money. This entry used to record that the settlement rule rendered "Nothing has left your balance", which was false for a withdrawal whose funds are still RESERVED; that defect is fixed at the rule rather than by adding a second mail here, and both stuck templates now say the amount is held and refuse to invite a retry.',
  // ── the fourth, answered NO for a reason none of the three above uses ──────────────────────
  // Not "somebody else already told them" and not "the platform talking to itself": the user did
  // this, synchronously, and read the result. micro-org#495 §4.
  'wallet.conversion.completed':
    'The user pressed convert and read the answer. `convert()` in wallet/src/money.ts prices, books and returns the finished figures in the SAME request — there is no pending state, no counterparty and no third party who has to act, so by the time this event exists the only person it concerns has already seen both sides of it on screen. That is the distinction from wallet.deposit.confirmed, which notifies: a deposit arrives while nobody is looking, and a conversion cannot. There is also nobody else to tell — a conversion moves one user\'s own balance between two of their own assets, so the recipient list is exactly the person who initiated it. The record belongs in the feed, and micro-activity classifies this topic into the `conversion` category for precisely that. If conversions ever become asynchronous — a desk that queues an order it cannot fill immediately rather than refusing it with desk_inventory_short — then the FILL becomes news, and it gets a rule under its own topic rather than this one.',
  // ── aetherholm, the first game in the registry ─────────────────────────────────────────────
  // Phase 2 changed the answer for two topics: battle.resolved and spire.captured now have
  // RULES above — the first game events worth an interruption. The phase-1 five below keep
  // their reasons, each a decision rather than a deferral, and season.sealed joins them.
  'worlds.title.registered':
    'An operator act on the platform with no player subject. The operator who ran it is looking at the result; a notification would inform the person who just did the thing.',
  'worlds.provision.completed':
    'Same reasoning as aetherholm.skerry.provisioned: the outcome surfaces on the worlds provisions screen the buyer is already on. The FAILURE notifies (see the rule), because a failure is the case the buyer is not watching for.',
  'emberkin.achievement.unlocked':
    'The player unlocked it in-game and the game celebrates it in-game. An out-of-band ping for an in-band moment trains people to ignore this channel; the feed keeps the record.',
  'emberkin.battle.resolved':
    'The player fought the battle themselves, watching. Confirming a thing the person just did is noise; the feed keeps the record.',
  'emberkin.cosmetic.equipped':
    'The player equipped it, in the wardrobe screen, on purpose. Nothing here is news to its only possible recipient.',
  'emberkin.save.started':
    'Starting a campaign is the beginning of a session, not an event to interrupt it with.',
  'emberkin.season.started':
    'A world event with no individual subject, like aetherholm.season.opened: announcing a season is marketing, and /admin/broadcasts is the honest channel for it.',
  'aetherholm.season.opened':
    'A world event with no individual subject. Announcing a season is product marketing, not a notification; a broadcast through /admin/broadcasts is the honest channel if one is wanted.',
  'aetherholm.city.founded':
    'The user themselves just did it, in the client, and is looking at the city they founded. Confirming a thing the person watched happen is noise that trains them to ignore this channel.',
  'aetherholm.building.completed':
    'Phase-1 queues are minutes long and the player is usually present; a per-completion ping would be the worst noise source in the estate. A digest-eligible completion notification is a later, deliberate decision once real queue lengths exist.',
  'aetherholm.research.completed':
    'Same reasoning as building.completed: present-player noise now, a possible digest entry later, decided with data rather than by default.',
  'aetherholm.skerry.provisioned':
    'The provision is requested from worlds and its outcome surfaces in the worlds provisions screen the buyer is already on. If provisioning ever becomes slow enough to leave, a completion notification becomes worth its interruption and gets a rule.',
  'aetherholm.season.sealed':
    'A world event whose personal half already notifies: every victor hears through spire.captured, with the members carried on that payload. Telling every player their world ended is an announcement, not a notification — the broadcast channel is the honest one, and worlds consumes this event for heraldry entitlements, not people.',
  'ledger.reconciliation.completed':
    'Custody total against indexer-observed total. It concerns operators and freezes withdrawals; no individual user is its subject.',
  // ── settlement's handover topics ───────────────────────────────────────────────────────────
  // `settlement.outbound.failed` USED TO BE HERE, recorded as "a notification the estate still
  // owes somebody" because its envelope named nobody. It is a rule now: settlement put `userId` on
  // the payload (withdrawals.ts) and the recipient — the only thing that was missing — resolves.
  // The two that remain are settlement talking to wallet or to reconciliation, not to a person.
  'settlement.outbound.confirmed':
    "wallet's own narrow name for the same movement settlement.withdrawal.completed announces: `confirmedEvents` in settlement/src/withdrawals.ts returns both from one call, and says so — 'Two topics for one fact … `settlement.outbound.confirmed` is wallet's name and is deliberately narrow — everything wallet needs to settle a reservation and nothing else'. It exists to release that reservation — wallet consumes it as `SETTLEMENT_CONFIRMED` in wallet/src/settlement.ts — and carries a withdrawal id, a hash and a timestamp. A rule here as well would tell one user their withdrawal arrived twice. Note that this is NOT the shape of the failure twin, which had no user-facing counterpart at all and is now mapped: a second rule here would duplicate a notification, whereas the failure had none.",
  // ── tessera ────────────────────────────────────────────────────────────────────────────────
  // TWO of the seven, and both are decisions: the fact reaches nobody because there is nobody it
  // is news to. There used to be four.
  //
  // `tessera.parcel.fallowed` and `tessera.venue.booked` were the other two and were NOT decisions
  // — each was a DEFERRAL, recorded here as such and paired with a `no-subject` record in
  // `topics.ts` naming `micro-tessera` as the owner. tessera `33ead39` put `ownerSubject` on both
  // payloads, so both are rules above and both records are deleted. Keeping either entry here now
  // would say the envelope names nobody beside a rule that reads the somebody it names, and
  // `topics.test.ts` fails on exactly that: a registered topic may be mapped OR recorded, never
  // both. That is the third time this pairing has resolved this way — see the tessera block comment
  // in `RULES` for why the record was the right thing to write instead of the rule.
  'tessera.parcel.claimed':
    'The claimant claimed it, in the client, and is standing on the ground they just took — land is free and the claim is synchronous (world.ts, the emit is inside the same transaction as the insert). aetherholm.city.founded exactly. The only other party is the ward, which is not a person.',
  'tessera.ward.opened':
    'A world event with no individual subject: the payload is a ward id, a slug, an archetype, an ordinal and a tile count, and names no user at all. Opening a ward is inventory, announced when it is worth announcing through /admin/broadcasts. aetherholm.season.opened.',
  // ── trade: four of the six that arrived with micro-org#345 ────────────────────────────────
  // The other two are RULES above. The line between them is not how much money is involved — a
  // fill can be larger than a fee — but whether the reader is somewhere else and whether anything
  // else will tell them. All four below fail one of those two tests, and the first three fail the
  // same one `aetherholm.city.founded` and `wallet.deposit_address.assigned` fail.
  'trade.bot.created':
    'The user is looking at the bot they just configured. Creating a bot is a form submission with a synchronous response — `insertBot` returns the row the client renders — and no money has moved: the ledger is not called until the bot is STARTED. Confirming a thing the person watched happen, about money that has not moved, is the purest form of the noise that teaches people to filter this channel. The feed keeps the record, and `trade.bot.paused` above is the half of a bot\'s lifecycle that is genuinely news, because it happens while they are not there.',
  'trade.bot.started':
    'Same reasoning as trade.bot.created: the owner pressed start and is on the screen watching the bot go green. The one thing here that would be worth an interruption — the ledger reservation that takes a live bot\'s allocation out of the spendable balance — is a consequence the user chose in the same gesture, seconds earlier, and it is on the record either way (`contracts` audits this topic, and activity files it as a financial record). The asymmetry with `trade.bot.paused` is deliberate and is the whole shape of this block: stopping is what happens without being asked.',
  'trade.fill.settled':
    'A running bot fills continuously — that is what it is for — so a rule here is one message per fill, per bot, for as long as the bot runs, which would be the largest noise source in the estate by an order of magnitude. It also names nobody: the emit passes no actor, so the envelope is `service:trade`, and the payload is `{ fillId, botId, side, qty, shards, entryId }` with no user on it at all, so this rule could only ever have answered no_recipient. The bot\'s own settlement history is the right surface for a sequence, and the fee that comes OUT of those fills is the fact worth a message — see the trade.fee.settled rule.',
  'trade.order.filled':
    'The terminal shows fills live, as they happen, which is where the person who placed the order is standing — an exchange order is placed from a screen whose whole purpose is watching it fill, and partial fills mean one order can produce several of these. This is the trade-desk form of the argument emberkin.battle.resolved makes: an out-of-band ping for an in-band moment. It is also behind TRADE_EXCHANGE_ENABLED today, and a rule written now would be a notification nobody has ever received being tuned by nobody; when the venue is live and there is evidence about how long an order rests unfilled, a resting-order rule is a decision worth making with that data.',
  'settlement.sweep.completed':
    "A deposit address emptied into the pinned treasury. No user balance changes — wallet credited the deposit when it confirmed, long before the sweep — so there is nothing here a person could act on or would recognise. It exists for reconciliation, which is the one movement no other topic reports, and it is keyed by the sweep source rather than by anybody.",
  // ── mint ───────────────────────────────────────────────────────────────────────────────────
  // The only mint topic that is not a rule. The rest of the deploy path — paid, broadcast,
  // confirmed, failed — is addressed to the buyer, because the buyer is waiting for a token.
  // ── agora: thirteen of the fourteen, and the same answer thirteen times ────────────────────
  // The fourteenth — `agora.notification.mail_requested` — is the rule above, and this block is
  // the other half of that decision rather than thirteen separate deferrals. agora keeps its own
  // notification table, applies the reader's own email preferences to it, waits out a window so a
  // burst is one mail, and then asks for exactly the mail it wants. Everything below is a RAW FACT
  // about the square, published for activity's feed and for anybody building on the bus; deriving
  // notifications from them here would re-decide, badly and without the reader's preferences, a
  // question the producer has already answered. That is a stronger form of the argument
  // `settlement.outbound.confirmed` makes: not "somebody else already tells them", but "somebody
  // else already decided whether to".
  'agora.post.created':
    'A post is the square working, not news. Every one of these would have to be fanned out to a follower list this service does not hold and must not copy, and the reader who wants the fan-out already gets it: agora writes a notification row for the replies, quotes and mentions that name a person, and asks for mail on exactly those through agora.notification.mail_requested. A rule here would mail every follower of every post ever written.',
  'agora.post.edited':
    'The author edited it, in the composer, looking at it. Nobody else is a candidate — an edit is not addressed to anyone, and agora writes no notification row for one — so a rule here could only ever tell somebody a thing they just did. aetherholm.city.founded exactly, in a smaller currency. The event exists for the feed and for anybody replaying the square, which is what it is registered for.',
  'agora.post.deleted':
    'Same shape as the edit, with one extra reason: the person who deleted a post is the person who no longer wants it discussed, and a mail about it is the platform reopening the subject. The one deletion somebody else needs to hear about is a MODERATOR removing it, and that is a notification row agora writes and a mail agora asks for, with the reason attached — see the agora.moderation variant.',
  'agora.spark.created':
    "A like. Mailing an author once per like is the single loudest thing this estate could do to somebody popular, and it is the canonical example of the notification people mute a product over. The author's half is not lost: agora writes the notification row, the square badges it, and the sweep offers mail only if the reader asked for that category and had not already read it.",
  'agora.echo.created':
    'A repost, and the same argument as the spark: it is affirmation rather than address, it arrives in bursts, and its whole value is cumulative — a count on the post — rather than per-event. agora holds the row so the count and the list of who echoed are both there when the author looks, which is where somebody actually goes to find out.',
  'agora.voice.renamed':
    "Somebody changed their own handle, in their own settings, and is looking at the result. The parties who might care — people who follow them — are a list this service does not hold, and telling them would be a notification about somebody else's cosmetic choice. The feed keeps the record, and the old handle is released rather than aliased, which is the fact that actually matters and is documented in the square.",
  'agora.voice.suspended':
    'The suspended person IS told, by name and with the moderator\'s reason, and not from here: agora writes a `moderation` notification row in the same transaction as the suspension, and the sweep asks for that mail through agora.notification.mail_requested, which the variant above renders as agora.moderation. A rule here would be a second mail about one suspension, and the two could not share a dedupe key because they would be keyed by two producers on two different ids. This entry is the wallet.withdrawal.refunded shape, decided the same way.',
  'agora.follow.created':
    'The followee is told by agora, which writes a `follow` or `follow_request` notification row and lets the reader decide through `on_follow` whether that is worth an email. A rule here would ignore that preference — this service cannot see it — and would also mail on a PENDING request that the followee may never accept, which is a mail about a thing that did not happen.',
  'agora.bar.created':
    'A bar must be silent, and that is the whole design. agora answers a barred voice as if the barrer were not there rather than telling them they were blocked, so a notification would defeat the feature for the person it protects; and the barrer is the one who did it, in the menu, on purpose. Neither party is a recipient. The event exists so moderation and the feed can see the act, not so anybody is told about it.',
  'agora.circle.created':
    'The founder opened it, filled the form and is standing in the circle they just made. Nobody else exists yet — a circle has one member at creation — so there is literally no second party to notify. Being invited to one is the fact worth a message, and that is a notification row agora writes and a mail the sweep asks for.',
  'agora.whisper.sent':
    'A private message, and this is the one topic in the square whose payload deliberately carries nothing — no text, no recipient, no subject, only a length and a thread id. That is not an omission to be fixed: filing "who messaged whom, and when" would build a social graph out of events designed to carry none. The recipient is still told, by agora, from the message itself, and mails it if `on_whisper` says so.',
  'agora.report.filed':
    'A report is addressed to moderators, who are not users with notification preferences, and its subject is a person who must not learn they were reported — that is how a reporter gets retaliated against. The reporter is not told either, deliberately: an acknowledgement that a report was received is the queue talking, and the queue is /moderation. Operators watch this through the moderation surface and the feed, which is what the event is registered for.',
  'agora.moderation.acted':
    'The audit trail of a moderator\'s action, keyed by the action and actored by the operator. Its subject hears about the outcome — a removal or a suspension — through the `moderation` notification agora writes, with the reason attached, which the agora.moderation template renders. This event is the operator-side record of the same act: a rule here would either mail the moderator about their own decision or mail the subject a second time about one removal.',
  'mint.deploy.funding_requested':
    "The platform paying its own gas. A paid order gets its own deployer address, and that address starts empty, so mint names the shortfall and settlement's treasury covers it — two of our services, one of our addresses, money that was never the buyer's. It names nobody either: the registry keys it by `token_id` and the payload carries a chain, a network, a deployer address and an amount in wei, with no user on it at all, so a rule here could only ever answer no_recipient. What the buyer is actually waiting for — that the token deployed, or that it did not — reaches them from mint.deploy.confirmed and mint.token.failed, which is the same argument settlement.outbound.confirmed makes about wallet's narrow twin: the funding step is plumbing under a fact somebody else already reports. Should the treasury ever be unable to cover it, that is an operator page and a metric (settlement's deployer top-up counters), not a mail to a customer who can do nothing about it.",
})

/**
 * Topics that mean "delete everything you hold about this user".
 *
 * Notify holds notification bodies, email addresses, phone numbers and push tokens, so it is one
 * of the services that most needs to honour this.
 *
 * **This comment used to end "identity.user.deleted currently has no subscriber anywhere in the
 * estate, which is precisely why there is no GDPR erasure path", and that has stopped being
 * true.** Three services consume it today: this one (`pipeline.ts`, `eraseUser`),
 * `activity/src/ingest.ts`, which erases rather than writing "your account was deleted" into
 * the feed of a user who no longer exists, and `trade/src/server.ts`, whose `SUBSCRIBED_TOPICS`
 * holds this and nothing else. The erasure path exists; what nobody has checked is whether every
 * service holding a `user_id` is on it, and that is a question only a checkout holding all of them
 * can answer — `micro-org`'s `tools/estate-topics.mjs`, the same place the cross-repository half of
 * `topics.ts`'s staleness question went.
 */
export const ERASURE_TOPICS: ReadonlySet<string> = new Set(['identity.user.deleted'])

/** Every topic this service will accept over `/ingest`. */
export function isKnownTopic(topic: string): boolean {
  return hasRule(topic) || ERASURE_TOPICS.has(topic) || Object.hasOwn(NON_NOTIFYING_TOPICS, topic)
}

/** Registry topics with no rule and no recorded reason. Empty in a correct build. */
export function unmappedRegistryTopics(): readonly TopicName[] {
  return (Object.keys(TOPICS) as TopicName[]).filter((topic) => !isKnownTopic(topic))
}
