/**
 * What notify has rules for, and the two-sided agreement with the shared registry.
 *
 * ## The defect this file exists to close
 *
 * `catalogue.test.ts` has always checked one direction: every topic in
 * `@cloudsforge/contracts-events` is either mapped or listed in `NON_NOTIFYING_TOPICS` with a
 * reason, so a topic added to the registry cannot be silently ignored here.
 *
 * **Nothing checked the other direction at all.** A rule could name any string, and fifteen of
 * them named topics no registry held. `events.ts` was written to tolerate exactly that, and its
 * reasoning was sound when it was written: notify is the fan-in of the entire bus and will always
 * be the first consumer of a new topic, so a well-formed envelope on an unregistered topic is
 * accepted **when this service already holds a rule for it**.
 *
 * The premise aged and nobody noticed. Its words were "the services that will produce them are not
 * written" — and by the time this file was added, eleven of the fifteen had a producer that was
 * very much written and emitting a **different name**:
 *
 * Each cites the producer by a NAME rather than by a line. Half of the `path:line` citations in
 * this paragraph were stale the last time anybody read them — `identity/src/server.ts` had
 * become a log line, `market/src/bids.ts` a field assignment — and a citation that has drifted
 * to a plausible neighbour is worse than none, because it reads as verified. A constant or a
 * function name moves with the code it names.
 *
 *   - `identity.password.changed` — identity never announces a password change; it revokes every
 *     session with `reason: 'password_changed'` (`identity/src/server.ts`, the `revokeAllSessions`
 *     call on the password-change route).
 *   - `wallet.deposit.detected` — wallet emits nothing when a deposit is seen, only when it is
 *     credited (`wallet/src/deposits.ts`, `DEPOSIT_CREDITED`).
 *   - `settlement.transaction.failed` — settlement emits `settlement.outbound.failed`
 *     (`settlement/src/outbox.ts`, `SETTLEMENT_OUTBOUND_FAILED`).
 *   - `trade.bot.triggered` / `trade.bot.stopped` — trade emits `created`, `started` and `paused`
 *     (`trade/src/bots.ts`, the three `topic: 'trade.bot.*'` emits).
 *   - `market.offer.received` — market emits `market.offer.made` (`market/src/bids.ts`,
 *     `OFFER_MADE_TOPIC`).
 *   - `devplatform.apikey.created` / `.revoked` — devplatform emits `devplatform.key.issued` and
 *     `devplatform.key.revoked` (`devplatform/src/apikeys.ts`, `emitKeyIssued` and
 *     `emitKeyRevoked`).
 *
 * A rule for a topic nobody emits is not a feature waiting for its producer. It is a feature that
 * reports itself as delivered: the coverage test counted it, `AD-08 requires a rule for X` passed,
 * and no notification could ever be produced by it. That is worse than the omission it hides.
 *
 * ## What is checked now, in both directions
 *
 *   1. **Every rule names a registered topic** — or a quarantined proposal below, which must carry
 *      the exact `TopicSpec` needed to register it and which empties itself once contracts adopts
 *      it. This is the direction that was missing.
 *   2. **Every registered topic has a rule or a written reason** — `unmappedRegistryTopics()` in
 *      `catalogue.ts`, asserted here as well so both halves are read in one place.
 *   3. **Every AD-08 notification with no producer is recorded, with the evidence** — see
 *      `UNPRODUCED_NOTIFICATIONS`. Deleting the rule and saying nothing would lose the requirement;
 *      keeping the rule claimed a coverage that did not exist. The record is the third option, and
 *      it names what the producer actually emits so the repair is one grep rather than an audit.
 *
 * Modelled on `identity/src/topics.ts`, deliberately: identity does this for the producer side —
 * emitted literals reconciled against the registry both ways, with a self-emptying quarantine for
 * what it cannot register itself. This is the consumer half of the same idea, and a second pattern
 * would mean two things to learn and two places to look.
 *
 * ## The third check was itself unable to fail, and five records rotted behind it
 *
 * The record structure in (3) came with a staleness check, `staleGaps()`, that asked whether the
 * SHARED REGISTRY named the topic a producer emits. It never fired, and it never could have: every
 * record it was watching described a topic that a live producer emits and no registry names, which
 * is precisely the condition the check treated as "still true". Five entries therefore sat here
 * saying a notification was impossible while `trade`, `market`, `devplatform` and `settlement` had
 * been emitting the exact topics this file itself had written down.
 *
 * The check is now `contradictedGaps()`, which asks only what this checkout can answer, and the
 * cross-repository half is delegated by name to `micro-org`'s `tools/estate-topics.mjs` — the only
 * checkout that holds every producer and every consumer at once. That function's own comment
 * carries the full argument, including why the old one was not fixable in place.
 *
 * Three of the five became rules quarantined in `AWAITING_REGISTRATION` below, and `micro-contracts`
 * has since registered all three, so that table is now empty — see its comment. Two did not become
 * rules, and the reason was written into each record: `settlement.outbound.failed` and
 * `market.offer.made` were real events whose envelopes named nobody this service could notify. That
 * distinction is what `blockedBy` carries, and it is why "the producer emits it" was never on its
 * own enough to write a rule.
 *
 * ## And both of those two have since closed, which is the fourth thing this file has learned
 *
 * `settlement.outbound.failed` is a rule now. Its record said the envelope named nobody; settlement
 * put `userId` on the payload (`settlement/src/withdrawals.ts`) and the sentence stopped being
 * true. `contradictedGaps()` is what forced the record's deletion — a rule and a record for the
 * same topic cannot both stand — so the repair emptied the record instead of leaving it beside the
 * code contradicting it. That is the property the five deleted records did not have, working, in
 * the one repository that can see it.
 *
 * `market.offer.made` closed the same way and within the hour. This paragraph used to read "has NOT
 * closed and is checked, not assumed", citing `bids.ts` for an envelope of
 * `{ listingId, offerId, offererSubject, amount, assetCode }` with no seller on it. That was true
 * when written and is now false twice over: `market/src/bids.ts` sends `sellerSubject`, read
 * off the listing row the emitting transaction holds `for update`, and the line numbers had drifted
 * besides. Both are the warning this file's own header gives about `path:line` citations — a prose
 * paragraph is the one part of this file nothing can fail on, so it is the part that rots. What is
 * checked rather than written is in `topics.test.ts`, "every no-subject record that a producer has
 * since fixed is gone", which asserts the rule exists and the record does not.
 *
 * ## And so did the two after them, which makes it four for four
 *
 * `tessera.parcel.fallowed` and `tessera.venue.booked` were recorded the same night, found by asking
 * every topic in the estate the question that found the offer — "does the envelope name only the
 * person who acted?" — and were the harder pair, because on both of them the actor is a perfectly
 * good user id. A rule reading it would have resolved somebody, rendered, and delivered: the
 * challenger told that they had challenged, the booker told that they were owed their own money.
 * `micro-tessera` 33ead39 added `ownerSubject` to both, off the `parcels` row each emitting
 * transaction already held `for update`, and both are rules now.
 *
 * **Four `no-subject` records, four closed by the producer adding one field, none closed by this
 * service guessing a recipient.** That is the argument for the record: writing the rule anyway
 * would have satisfied every coverage test in this repository and produced four notifications for
 * the wrong people, and none of the four fields would exist. `topics.test.ts` asserts the set is
 * empty now — "the tessera deferrals are gone from every place that claimed the gap" — so a fifth
 * has to be declared rather than accumulated.
 */

import {
  isRegisteredTopic,
  isValidTopicName,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { MAPPED_TOPICS, hasRule, unmappedRegistryTopics } from './catalogue.ts'

export interface ProposedTopic {
  /** Why notify holds a rule for a topic the estate has not named. Read by a human. */
  readonly reason: string
  /**
   * The emit site that proves a producer really sends it. `<repo>/src/<file>.ts:<line>`.
   *
   * **Null is a new and strictly worse state, and it is here because the alternative was a lie.**
   * Every entry this table has ever held was a rule ahead of the REGISTRY, with a producer already
   * emitting it — so proof of the producer was always available and always required. A rule ahead of
   * its PRODUCER had no representation at all, which left an author facing one exactly two options:
   * cite a line number that does not carry the emit, or not write the rule. The first is the fault
   * this file's own header warns about at length ("a citation that has drifted to a plausible
   * neighbour is worse than none, because it reads as verified"), and `malformedProposals` checks
   * the SHAPE of this string and could never have caught it. The second is how a service ends up
   * shipping a fortnight after the producer.
   *
   * So the state is representable, and it costs something to be in: `awaitingProducer` must name the
   * repository and the change, and `unprovenProposals()` lists every entry in it for
   * `topics.test.ts` to pin as an exact set — so a second one is an edit somebody has to make and
   * argue for, rather than an accumulation.
   */
  readonly emittedAt: string | null
  /**
   * Who is writing the producer, and what they are writing. Required when `emittedAt` is null.
   *
   * `repo` is `micro-<name>`, the same spelling `UNPRODUCED_NOTIFICATIONS.owner` uses, so the two
   * tables name repositories the same way and one grep finds both.
   */
  readonly awaitingProducer?: { readonly repo: string; readonly change: string }
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Rules for topics the registry does not yet name.
 *
 * The situation this exists for is real: notify is the first consumer of every new topic, and a
 * rule that lands one deploy before the registration is a legitimate state. What is not legitimate
 * is that state being invisible.
 *
 * An entry must carry the spec that would register it and the emit site that proves the producer
 * exists, so adopting it into contracts is a copy rather than a fresh design — and the test below
 * fails the moment contracts adopts one and the entry is not deleted, so this cannot rot into a
 * permanent allow-list the way the fifteen did.
 *
 * **It is empty, and that is the mechanism finishing rather than a mechanism nobody uses.** It held
 * `trade.bot.paused`, `devplatform.key.issued` and `devplatform.key.revoked` for about half an
 * hour. Each had been a record in `UNPRODUCED_NOTIFICATIONS` saying the notification could not be
 * produced while its producer had been emitting the topic all along, under the name this file
 * itself had written down; each was quarantined with the spec that would register it, copied
 * verbatim from the producing service's own quarantine so the two repositories could not propose
 * two different contracts for one topic. `micro-contracts` adopted all three
 * (`contracts/packages/events/src/index.ts`) — its own commit says landing them
 * "makes `adoptedProposals()` non-empty in micro-trade, micro-devplatform and micro-notify, whose
 * suites now fail until the matching quarantine entries are deleted. That is the self-emptying
 * quarantine working, not a regression this commit introduced." It was right: this repository's
 * suite went red for exactly that, and these are the deletions it was asking for.
 *
 * It emptied, and then it was used again within the hour, and then it emptied a second time — which
 * is the best evidence that the situation it exists for is normal rather than exceptional.
 * `market.offer.made` was that second entry, and it was the mechanism at its most useful: a record
 * in `UNPRODUCED_NOTIFICATIONS` said the rule could not be written, `micro-market` supplied the
 * field that made it writable, and the topic was still unregistered. Without this table the choice
 * would have been between a rule nothing can see is ahead of the registry and a record that has
 * stopped being true. `micro-contracts` registered it two hours later (5e0d11a, pasting the spec
 * and re-reading `keyedBy` off `market/src/bids.ts`), `adoptedProposals()` turned this suite
 * red, and the entry is gone. The rule stays: it is a registered topic now, so
 * `unregisteredRuleTopics()` is what holds it, and `catalogue.ts` carries the reasoning.
 *
 * The spec of every entry is copied VERBATIM from the producing service's own quarantine, so
 * `micro-contracts` adopting it is a paste and the two repositories cannot propose two different
 * contracts for one topic. That held: contracts' own commit says the description it registered is
 * "character for character theirs".
 */
/*
 * EMPTY, and `identity.email.verification_requested` is why it is empty TODAY.
 *
 * That entry was the first one here that was ahead of its PRODUCER rather than merely ahead of the
 * registry. Both have now landed: `micro-identity` 1.1.0 emits it
 * (`identity/src/emailVerification.ts`) and `micro-contracts` registers it
 * (`contracts/packages/events/src/index.ts`, from identity's verbatim spec).
 *
 * ── WHAT THE GAP BETWEEN THE THREE LANDINGS COST, LIVE ────────────────────────────────────────
 *
 * identity shipped to production before contracts did. For that window every registration on both
 * estates produced an event this service answered with 400 —
 *
 *     topic: "identity.email.verification_requested" is not in this registry;
 *     contracts-events may be behind
 *
 * — so the mail was never rendered, and sign-in refused the account with `email_unverified`.
 * Registration returned "check your email" and no email could ever arrive. This table existing is
 * what made that diagnosable in one grep; what it could not do is stop a producer being deployed
 * ahead of the contract, because deployment order is not a property of a checkout.
 *
 * It emptied, and it is in use again, which is the third time and the ordinary case rather than the
 * exceptional one. `identity.password.reset_requested` is the entry, and this time the order is
 * being kept deliberately: the lesson above is that a PRODUCER deployed ahead of its contract is
 * the thing that reaches users, so this consumer's rule and the producer's emit go out together and
 * the registry entry is the one piece owned by another repository.
 *
 * ── AND IT IS EMPTY AGAIN. `identity.password.reset_requested` was registered on 2026-08-08. ────
 *
 * `micro-contracts` adopted it from identity's quarantine spec, `adoptedProposals()` turned
 * non-empty, this suite went red, and the entry is deleted. Fourth time, same three steps, no
 * argument required — which is the property this table is for.
 *
 * The order the paragraph above says was being kept deliberately WAS kept, and it is worth being
 * precise about what that bought, because it is not what the verification incident would suggest.
 * Nothing broke and nobody noticed: the rule here and the emit in identity agreed for the whole
 * life of the feature, because both were pasted from the same quarantine spec. What the missing
 * registry entry cost was invisible instead — an unregistered topic fails `validateEnvelope`, so
 * `activity/src/ingest.ts` took its unregistered branch and filed every reset as
 * `unclassified` / `internal` with 90-day quarantine retention rather than the 730 days a security
 * record gets. The estate was deleting its own account-recovery trail early, in a third repository
 * neither of the two that agreed had any reason to look at.
 *
 * So the lesson is not "keep the producer behind the contract" alone. It is that two repositories
 * agreeing is not the same as the estate agreeing, and only an estate-wide check can tell the
 * difference — `org/tools/estate-topics.mjs` is the one that found this. micro-org#263.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({})

/**
 * An AD-08 notification this service cannot produce, and the ONE reason why.
 *
 * Each of these had a rule, and each rule was unreachable. The requirement is real and stays
 * visible here; what is deleted is the claim that notify covers it.
 *
 * ## `blockedBy` is new, and it is what makes the record checkable
 *
 * The shape used to be "requirement, the topic the deleted rule guessed at, what the producer emits
 * instead, evidence" — and it could not distinguish the three completely different situations it
 * was holding at once. `settlement.outbound.failed` and `devplatform.key.issued` had identical
 * record shapes, and one of them was a live notification waiting for a rule while the other is a
 * handover between two services that names nobody a notification could go to. Nothing could tell
 * them apart, so nothing could say which records were stale, so **four of them sat here for weeks
 * describing notifications that were one rule away**.
 *
 * Naming the reason closes that, because each reason implies something this checkout can verify:
 *
 *   - `no-event` — nothing on the bus carries the fact. `emits` must be null.
 *   - `no-subject` — the fact is on the bus and its envelope names nobody notify could address:
 *     no `user_id` in the payload and no `user:` actor. `emits` names the topic, and notify must
 *     hold no rule for it, because a rule would contradict this record.
 *   - `other-channel` — the fact reaches users without the bus, so a rule would DOUBLE-send.
 *     `owner` is null: there is nothing for anyone to change.
 *
 * `emits` is read out of the producer's source, not inferred from the name, and is kept as a bare
 * quoted topic literal on purpose: `micro-org`'s `tools/estate-topics.mjs` reads this constant BY
 * NAME (`RECORD_STRUCTURES`, direction 4) from a checkout that holds every producer, and a literal
 * is what it can match. That is the half of the staleness question this repository cannot answer —
 * see `contradictedGaps` below.
 */
export interface UnproducedNotification {
  /** The AD-08 kind of notification, in the words AD-08 uses. */
  readonly requirement: string
  /** The topic the deleted rule guessed at. Kept so the deletion is greppable. */
  readonly guessedTopic: string
  /**
   * The topic the producer really emits for this area, or null when it emits nothing at all.
   *
   * One topic, spelled exactly, so a machine outside this repository can match it against that
   * producer's emit sites. A list would be prose; put the rest in `evidence`.
   */
  readonly emits: string | null
  /** Why no rule can be written today. Exactly one reason, from a closed set. */
  readonly blockedBy: 'no-event' | 'no-subject' | 'other-channel'
  /**
   * The repository whose one change closes it — `micro-<repo>`.
   *
   * Null only for `other-channel`, where the requirement is already met and there is nothing to
   * change. Everything else names an owner, because a gap nobody owns is a gap nobody closes: the
   * estate gap file in micro-org learned the same thing and requires the same field.
   */
  readonly owner: string | null
  /**
   * Where that was verified: a path and a **symbol**, or a statement about the absence.
   *
   * Never a path with a line number appended to it. That form is a claim that goes stale on the
   * next edit ABOVE the thing it points at, takes no test with it when it does, and then reports
   * something that is not true — micro-org#235, where thirty cross-repo assertions failed for that
   * reason alone and one of them accused a service of skipping an `authenticate()` call it does
   * make. A symbol survives the edit and can be grepped for from either end, which is also the
   * property `topics.test.ts` now pins across this whole service.
   */
  readonly evidence: string
}

export const UNPRODUCED_NOTIFICATIONS: readonly UnproducedNotification[] = Object.freeze([
  Object.freeze({
    requirement: 'risk limit reached',
    guessedTopic: 'policy.limit.reached',
    emits: null,
    blockedBy: 'no-event',
    owner: 'micro-policy',
    evidence:
      'policy has no outbox at all — no outbox.ts, no `insert into outbox` anywhere in policy/src. A decision is a row in policy_decision (04-domain-model §10.4), read by admin-api over HTTP. Nothing about a limit reaches the bus, so a user is still told "it just did not work" by silence.',
  }),
  Object.freeze({
    requirement: 'deposit detected, before confirmation',
    guessedTopic: 'wallet.deposit.detected',
    emits: null,
    blockedBy: 'no-event',
    owner: 'micro-wallet',
    evidence:
      'wallet emits at credit time and not before: `postCredit` in wallet/src/deposits.ts emits DEPOSIT_CREDITED, keyed by wallet_id, and it is the only emit on that path. The seen-but-not-yet-credited state — the one that generates the support ticket — is a `watched_at` on the assignment row that `watchAssignment` sets in the same file, with no emit beside it, so it is visible to wallet and announced to nobody.',
  }),
  /* ────────────────────────────────────────────────────────────────────────────────────────────
   * DELETED: 'withdrawal transaction failed outright', guessed at `settlement.transaction.failed`,
   * recorded `blockedBy: 'no-subject'` against `settlement.outbound.failed`.
   *
   * It is a rule now — `catalogue.ts`, `settlement.outbound.failed` — and the record had to go
   * because `contradictedGaps()` fails while both exist. That is this file's own mechanism doing
   * the thing the five deleted records did not: writing the rule DELETES the record rather than
   * leaving a note saying the notification is impossible beside the code that produces it.
   *
   * The record was right when it was written and stopped being right in an hour. Its condition was
   * "an envelope on it names nobody this service could notify", and settlement put `userId` on the
   * payload (settlement/src/withdrawals.ts) — the same value `stuckEvents` already sent off the
   * same row. Worth noting what settlement did NOT do: this record's own evidence said "the repair
   * is settlement emitting one [a user-facing twin], exactly as it added the stuck twin", and
   * settlement declined, on the grounds that a `.failed` twin would be one fact under two official
   * names keyed identically — the `settlement.outbound.stuck` proposal micro-contracts had already
   * refused. It added the missing FIELD instead. The record's diagnosis was right and its
   * prescription was wrong, which is a good argument for evidence a reader can re-derive over a
   * repair somebody wrote down.
   *
   * micro-org's `tools/estate-topic-gaps.json` holds the estate-side half of this record, keyed
   * `stale-record:settlement.outbound.failed`, `status: 'deferred'` with an `until` that has now
   * been met. That file fails its step when a recorded finding is repaired and not deleted, so it
   * needs the same deletion. It is not in this repository's gift.
   * ──────────────────────────────────────────────────────────────────────────────────────────── */
  /* ────────────────────────────────────────────────────────────────────────────────────────────
   * DELETED: 'marketplace offer received', guessed at `market.offer.received`, recorded
   * `blockedBy: 'no-subject'` against `market.offer.made`.
   *
   * The second record to close in an hour, and the second whose deletion `contradictedGaps()`
   * forced rather than requested. Its evidence said the seller "is not carried" and that
   * "`listing.sellerSubject` is in scope three lines above the emit and is not put on the event".
   * `micro-market` put it on the event — `market/src/bids.ts`, commit "three topics named the
   * person who acted, not the person it happened to" — and its own quarantine entry names this
   * record as the thing that closes when notify writes the rule. It is written.
   *
   * The topic is not registered, so the rule is quarantined in `AWAITING_REGISTRATION` above with
   * the spec market is asking for, copied verbatim. That is the honest state and it is visible,
   * which is the whole difference between this and the fifteen rules that shipped naming topics no
   * producer emits.
   *
   * micro-org's `tools/estate-topic-gaps.json` holds `stale-record:market.offer.made`,
   * `status: 'deferred'`, with an `until` reading "market's OFFER_MADE payload carries the seller
   * subject". It does. That entry needs deleting too, and it is not in this repository's gift.
   * ──────────────────────────────────────────────────────────────────────────────────────────── */
  /* ────────────────────────────────────────────────────────────────────────────────────────────
   * DELETED, BOTH: 'your parcel is being contested' and 'somebody booked your venue', guessed at
   * `tessera.parcel.contested` and `tessera.venue.booked_for_owner`, recorded
   * `blockedBy: 'no-subject'` against `tessera.parcel.fallowed` and `tessera.venue.booked`.
   *
   * They were written hours after this file had congratulated itself on emptying the last two, and
   * writing them was the honest outcome rather than an embarrassing one: `micro-org`'s sweep found
   * the CLASS by asking one question of every topic in the estate — "does the envelope name only
   * the person who acted?" — and `micro-contracts` 41751b1 had just registered seven tessera topics
   * at once. Two of the seven answered yes. That was the class being findable, not the class
   * recurring, and it is the second half of that sentence these deletions settle.
   *
   * `micro-tessera` 33ead39 puts `ownerSubject` on both payloads, read from `select owner_subject,
   * ward_id from parcels where id = … for update` taken before the insert, in the order
   * `moveParcel` locks so the two serialise rather than deadlock. Its own test asserts the field as
   * a DIFFERENCE — Alice owns, Bob acts — because a payload deriving the owner from the actor
   * satisfies any presence check and names exactly the wrong person.
   *
   * That is FOUR no-subject records closed the same way in one night — `settlement.outbound.failed`,
   * `market.offer.made`, and these two — every one by the producer adding one field off a row its
   * emitting transaction already held, and not one by this service guessing. The refusal to write a
   * rule was the thing that produced the field.
   *
   * Both rules are in `catalogue.ts`, both resolve via `ownerSubject` and NOT `forUser` (the actor
   * is the challenger and the booker), and both `NON_NOTIFYING_TOPICS` entries are gone with them —
   * `contradictedGaps()` and the mapped-or-recorded check each fail while a record and a rule stand
   * together, which is the property the five deleted records did not have.
   *
   * micro-org's `tools/estate-topic-gaps.json` should be checked for entries mirroring these two,
   * as it was for `market.offer.made`. That is not in this repository's gift.
   * ──────────────────────────────────────────────────────────────────────────────────────────── */
  Object.freeze({
    requirement: 'auction ended',
    guessedTopic: 'market.auction.ended',
    emits: null,
    blockedBy: 'no-event',
    owner: 'micro-market',
    evidence:
      'No market.auction.* topic exists. `closeAuction` in market/src/orders.ts settles through the ordinary sale path, which emits SOLD_TOPIC — registered, and already notified on here — so the WINNER hears it as a sale. Nothing at all announces the close to a losing bidder, which is the half AD-08 asked for.',
  }),
  Object.freeze({
    requirement: 'service incident',
    guessedTopic: 'admin_api.incident.opened',
    emits: 'admin.broadcast.published',
    blockedBy: 'other-channel',
    owner: null,
    evidence:
      '`publishBroadcast` in admin-api/src/broadcasts.ts — an incident reaches users as an operator broadcast, which POST /admin/broadcasts already fans out through this service (`fanOutBroadcast` in pipeline.ts). A rule on the topic as well would send the same incident twice. The deleted rule claimed pipeline.ts recognised its category and routed it there; it does not — `ingestEvent` calls `ruleFor(event.topic)`, and with no rule it increments SUPPRESSED_TOTAL with `reason: \'no_rule\'` and returns — so the rule was a no-op guarding a path that never used it.',
  }),
])

/** Rule topics in neither the registry nor the quarantine — a notification that cannot fire. */
export function unregisteredRuleTopics(): readonly string[] {
  return MAPPED_TOPICS.filter(
    (topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic),
  ).sort()
}

/** Registry topics with no rule and no written reason. The direction that already existed. */
export function unmappedTopics(): readonly TopicName[] {
  return unmappedRegistryTopics()
}

/** Proposals the registry has since adopted. Non-empty means delete the entry. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/**
 * A proposal must describe a topic that could actually be registered, and account for its producer.
 *
 * "Account for" rather than "prove", now that `emittedAt` may be null: an entry either cites the
 * emit site or names the repository writing it and what is being written. What is refused in both
 * cases is the same — a proposal that says nothing checkable about who sends the event.
 */
export function malformedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION)
    .filter((topic) => {
      const proposed = AWAITING_REGISTRATION[topic]
      if (!proposed) return true
      const producer =
        proposed.emittedAt === null
          ? // No emit site, so the cost is naming who is writing one. The change description is
            // held to the same length as an evidence string in UNPRODUCED_NOTIFICATIONS: under
            // that, it is a label rather than something a reader could act on.
            !/^micro-[a-z-]+$/.test(proposed.awaitingProducer?.repo ?? '') ||
            (proposed.awaitingProducer?.change.length ?? 0) < 80
          : !/^[a-z-]+\/src\/[\w.-]+\.ts:\d+$/.test(proposed.emittedAt) ||
            proposed.awaitingProducer !== undefined
      return (
        !isValidTopicName(topic) ||
        !topic.startsWith(`${proposed.spec.producer.replace(/-/g, '_')}.`) ||
        proposed.spec.keyedBy === '' ||
        producer ||
        proposed.reason.length < 80
      )
    })
    .sort()
}

/**
 * Proposals whose producer is not written yet.
 *
 * Strictly worse than an ordinary quarantine entry, and separated from them so it reads that way: a
 * rule ahead of the registry cannot fire until contracts moves, a rule ahead of its producer cannot
 * fire until somebody writes the emit — and the fifteen rules this file was built to delete were
 * every one of them in the second state without anybody being able to see it.
 *
 * **This checkout cannot prove the emit exists**, and no check here should pretend otherwise; the
 * same argument `contradictedGaps` makes about the half of its question that lives in `micro-org`.
 * What it can do is force the set to be declared: `topics.test.ts` pins it as an EXACT list, so a
 * second entry is an edit somebody has to make and defend, and landing a producer means replacing
 * `emittedAt: null` with the line — which is the edit that removes the topic from here. The registry
 * ratchet is unchanged and still the thing that eventually empties the table: `adoptedProposals()`
 * turns the suite red the moment contracts registers it and the whole entry has to go.
 */
export function unprovenProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION)
    .filter((topic) => AWAITING_REGISTRATION[topic]?.emittedAt === null)
    .sort()
}

/**
 * A record this service's OWN catalogue contradicts.
 *
 * ## What was here before, and why it could not fail
 *
 * `staleGaps()` asked whether `@cloudsforge/contracts-events` NAMES the topic a producer emits, and
 * called the record stale when it did. That is the wrong oracle, and the wrongness is not subtle
 * once stated: **the registry is not the producer.** A topic can be registered and emitted by
 * nobody — `custody.key.exported` was, for the whole life of that service — and a topic can be
 * emitted by a live producer for months while no registry names it, which is the case all five of
 * the records deleted from this file were in. So the check answered a question nobody had asked,
 * and every one of its subjects was invisible to it by construction. It was the self-emptying
 * quarantine's twin in shape and not in effect: a record that empties only when somebody remembers
 * is not self-emptying, and this one emptied only when a THIRD repository moved.
 *
 * It could not have been fixed in place, either, and that is the honest part. The question it was
 * standing in for is "does a producer emit this today?", and **no check inside micro-notify can
 * answer it**: this checkout holds the consumer half of the bus and nothing else. Making the check
 * look harder would have made it look more convincing without making it able to fail.
 *
 * ## So the question was split, and each half is asked where it can be answered
 *
 * The cross-repository half now lives in the only checkout that has both halves in it:
 * `micro-org`'s `tools/estate-topics.mjs` clones all 56 repositories, derives every emit site in
 * the estate, reads THIS constant by name (`RECORD_STRUCTURES`, direction 4) and fails when a
 * record here names a topic a producer emits. That is how the five were found. Its findings ratchet
 * through `tools/estate-topic-gaps.json`, which fails when a recorded finding is repaired and not
 * deleted — the self-emptying property, moved to where it can hold.
 *
 * What is left here is the half this repository can prove, and it is a real one: **a record must
 * not contradict notify's own rule table.** If a rule exists for the topic a record says cannot be
 * notified on, one of the two is wrong, and the record is the one that has to go. That is what
 * makes writing the rule delete the record rather than leaving both — the exact failure mode the
 * five had, seen from the side this checkout can see.
 *
 * `isRegisteredTopic` is still imported and still used, by `unregisteredRuleTopics` and
 * `adoptedProposals`, which ask about the registry things the registry actually knows.
 */
export function contradictedGaps(): readonly string[] {
  return UNPRODUCED_NOTIFICATIONS.filter((gap) => gap.emits !== null && hasRule(gap.emits))
    .map((gap) => gap.guessedTopic)
    .sort()
}

/**
 * A record whose stated reason does not match its own fields.
 *
 * Cheap, and it is what stops `blockedBy` becoming decoration. Each reason implies something about
 * the rest of the record (see `UnproducedNotification`), and a record that claims one reason while
 * carrying the shape of another is a record nobody can act on.
 */
export function inconsistentGaps(): readonly string[] {
  return UNPRODUCED_NOTIFICATIONS.filter((gap) => {
    switch (gap.blockedBy) {
      // Nothing on the bus carries the fact, so there is no topic to name.
      case 'no-event':
        return gap.emits !== null || gap.owner === null
      // The fact is on the bus; the record must say which topic, and who fixes the payload.
      case 'no-subject':
        return gap.emits === null || gap.owner === null
      // Already delivered another way. Naming an owner would ask somebody to change nothing.
      case 'other-channel':
        return gap.emits === null || gap.owner !== null
    }
  })
    .map((gap) => gap.guessedTopic)
    .sort()
}
