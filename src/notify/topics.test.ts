/**
 * The consumer half of the bus contract, checked in both directions.
 *
 * The direction this service already had — every registry topic is mapped or has a written reason
 * — is asserted here too, so both halves are read together. The direction it did not have is the
 * first test: a rule for a topic no registry names is a notification that cannot fire, and fifteen
 * of them shipped because nothing looked.
 *
 * No database. Pure set arithmetic over the rule table and the frozen registry, so it runs in CI
 * even when the database-backed suite skips.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { TOPIC_NAMES, isRegisteredTopic, parseActor, type Actor } from '@cloudsforge/contracts-events'
import { MAPPED_TOPICS, NON_NOTIFYING_TOPICS, RULES, hasRule, isKnownTopic } from './catalogue.ts'
import {
  AWAITING_REGISTRATION,
  UNPRODUCED_NOTIFICATIONS,
  adoptedProposals,
  contradictedGaps,
  inconsistentGaps,
  malformedProposals,
  unmappedTopics,
  unprovenProposals,
  unregisteredRuleTopics,
} from './topics.ts'
import { unregisteredEvent, ALICE } from './testsupport.ts'

test('every rule maps a topic the estate has a name for', () => {
  // The direction that was missing. A rule keyed to a topic no producer can legally emit is a
  // feature that reports itself as delivered: the coverage test counts it, AD-08 is satisfied on
  // paper, and no notification is ever produced.
  assert.deepEqual(
    unregisteredRuleTopics(),
    [],
    'a rule for a topic in neither the registry nor AWAITING_REGISTRATION — find the producer, then delete the rule or register the topic it really emits',
  )
  // And the registry is being read rather than the check passing vacuously.
  assert.ok(TOPIC_NAMES.length >= 40)
  assert.ok(MAPPED_TOPICS.length >= 25)
})

test('every registry topic is mapped or explicitly not notifying', () => {
  // The half that already existed, asserted beside its opposite so neither is read alone.
  assert.deepEqual(
    unmappedTopics(),
    [],
    'a registry topic with no rule and no recorded reason — decide what notify does with it',
  )
})

test('a pending proposal disappears once contracts adopts it', () => {
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a valid topic name under its producer, a real ordering key, the emit site that proves the producer sends it, and a reason worth reading',
  )
})

/**
 * The entries that are ahead of their PRODUCER, not merely ahead of the registry.
 *
 * Strictly the worse of the two states and, until this list existed, the one with no representation
 * at all — which left an author holding a rule whose producer was being written that week with a
 * choice between citing a line number that carries no emit and not writing the rule. The first is
 * the fault `topics.ts`'s own header spends a paragraph on; `malformedProposals` checks the SHAPE of
 * `emittedAt` and would have passed a plausible lie without blinking.
 *
 * The set is EXACT for the same reason `UNPRODUCED_NOTIFICATIONS` is: a floor gets ratcheted by
 * whoever is adding to it, and this is a state that must cost an edit and an argument. Landing the
 * producer means replacing `emittedAt: null` with the emit site, which is the edit that empties this
 * list; contracts registering the topic fires `adoptedProposals()` and deletes the whole entry.
 *
 * **No check here can prove the emit exists** — this checkout holds the consumer half of the bus and
 * nothing else, the same limit `contradictedGaps()` states about its own question. What is asserted
 * is what this repository can answer: the state is declared, it is the only one, and it carries the
 * repository and the change that closes it.
 */
test('a rule ahead of its producer says so, and names who is writing the producer', () => {
  /*
   * EMPTY, and it got there the way the ratchet above says it should: the producer landed and then
   * the registry did. `identity.email.verification_requested` was the only entry this list has ever
   * held — `micro-identity` 1.1.0 emits it at `identity/src/emailVerification.ts`, and
   * `micro-contracts` has registered it, which fires `adoptedProposals()` and deletes the entry.
   *
   * The list stays EXACT rather than becoming a floor for the reason the header gives: a state that
   * must cost an edit and an argument. Adding an entry here must fail this line and make somebody
   * write down which producer is being changed and by whom.
   */
  assert.deepEqual(
    unprovenProposals(),
    [],
    'a proposal with no emit site was added or landed — cite the emit, or say why a second is owed',
  )
  for (const topic of unprovenProposals()) {
    const proposed = AWAITING_REGISTRATION[topic]
    assert.equal(proposed?.emittedAt, null)
    assert.match(proposed?.awaitingProducer?.repo ?? '', /^micro-[a-z-]+$/, `${topic}: name the repository`)
    assert.ok(
      (proposed?.awaitingProducer?.change.length ?? 0) > 80,
      `${topic}: say what is being written, not that something is`,
    )
    // The rule exists — the quarantine explains a rule, and an entry with none explains nothing —
    // and the topic is accepted at /ingest, so the event is handled the day it starts arriving
    // rather than 400ing until somebody notices.
    assert.equal(hasRule(topic), true, `${topic} is quarantined with no rule`)
    assert.equal(isKnownTopic(topic), true, `${topic} would be refused at /ingest`)
    assert.equal(isRegisteredTopic(topic), false, `${topic} is registered — this entry should be gone`)
  }
})

/**
 * The eleven rules that could never fire, and what each one's producer actually emits.
 *
 * This is the regression pin. Re-adding any of these names is re-adding the defect, because the
 * name is the thing that was wrong — the notification each one described is still wanted, and the
 * repair is to register what the producer really sends and key a rule to that.
 *
 * Four of the eleven have since had that repair: `trade.bot.stopped` is now a rule on
 * `trade.bot.paused`, `devplatform.apikey.created` and `.revoked` are rules on
 * `devplatform.key.issued` and `.revoked`, and `identity.password.changed` rides
 * `identity.session.revoked`. The guessed names below stay wrong and stay refused.
 */
test('the rules for topics nobody emits stay deleted', () => {
  for (const topic of [
    'identity.password.changed',
    'policy.limit.reached',
    'wallet.deposit.detected',
    'settlement.transaction.failed',
    'trade.bot.triggered',
    'trade.bot.stopped',
    'market.offer.received',
    'market.auction.ended',
    'devplatform.apikey.created',
    'devplatform.apikey.revoked',
    'admin_api.incident.opened',
  ]) {
    assert.equal(hasRule(topic), false, `${topic} has no producer — a rule for it cannot fire`)
    assert.equal(isRegisteredTopic(topic), false, `${topic} is emitted by nobody; do not register it`)
    // And it is not accepted at /ingest either, so a POST naming one is refused rather than stored.
    assert.equal(isKnownTopic(topic), false)
  }
})

test('every unproduced notification names the producer that decided it', () => {
  // The EXACT set, not a `length >= n` floor.
  //
  // The floor was `>= 5` and it had to be edited the moment a record closed, which is a number that
  // gets ratcheted downwards by whoever is closing a record — the one person who will not think
  // twice about it. This is stronger in both directions: a record added without a decision fails
  // here, and a record deleted without the rule that justifies the deletion fails here too. The
  // original intent, "the records are being read rather than an empty array", is kept by the same
  // assertion rather than by a separate one that can pass vacuously.
  assert.deepEqual(
    UNPRODUCED_NOTIFICATIONS.map((gap) => gap.requirement).sort(),
    [
      'auction ended',
      'deposit detected, before confirmation',
      'risk limit reached',
      'service incident',
      // REMOVED, both: 'somebody booked your venue' and 'your parcel is being contested'. They were
      // added when `micro-contracts` 41751b1 registered tessera's seven topics and all seven were
      // put to the question that found market.offer.made — "does the envelope name only the person
      // who acted?". Two said yes: `tessera.parcel.fallowed` named the challenger and not the owner
      // losing the ground, `tessera.venue.booked` named the booker and not the owner being paid.
      //
      // `micro-tessera` 33ead39 put `ownerSubject` on both payloads, off the parcel row the emitting
      // transaction already held `for update`, so both sentences stopped being true and both rules
      // are written. Deleting a record needs the rule that justifies it, which is what this
      // assertion is for in this direction — see 'the tessera deferrals are gone from every place
      // that claimed the gap' below, which asserts all four moves for both topics.
      //
      // What is left is four records with NO event at all (`no-event`) or another channel. Not one
      // `no-subject` record remains: every one this service ever wrote was closed by its producer
      // adding one field, three times over, and never by this service guessing a recipient.
    ],
    'a recorded gap was added or removed — say which, and why, here',
  )
  for (const gap of UNPRODUCED_NOTIFICATIONS) {
    assert.ok(gap.requirement.length > 5, `${gap.guessedTopic}: name the AD-08 requirement`)
    assert.equal(hasRule(gap.guessedTopic), false, `${gap.guessedTopic} is recorded AND mapped`)
    assert.ok(
      gap.evidence.length > 80,
      `${gap.guessedTopic}: cite the source that proves what the producer emits — under 80 characters is a guess`,
    )
    // A gap whose `emits` is a topic must spell it as ONE legal topic name. A list would be prose,
    // and micro-org's estate check matches this field as a literal — the record that spelled three
    // topics into it ('trade.bot.created, trade.bot.started, trade.bot.paused') was invisible to
    // that check for exactly this reason.
    if (gap.emits !== null) {
      assert.match(gap.emits, /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/, `${gap.guessedTopic}: ${gap.emits}`)
    }
    // An owner, or the one reason there is nothing to own.
    if (gap.blockedBy === 'other-channel') {
      assert.equal(gap.owner, null, `${gap.guessedTopic}: already delivered; nothing to change`)
    } else {
      assert.match(gap.owner ?? '', /^micro-[a-z-]+$/, `${gap.guessedTopic}: name the repository that closes it`)
    }
  }
})

test('a record cannot claim a reason its own fields contradict', () => {
  assert.deepEqual(
    inconsistentGaps(),
    [],
    "a record's blockedBy disagrees with its emits/owner — see UnproducedNotification for what each reason implies",
  )
})

/**
 * The check that replaced `staleGaps()`, and the only staleness this checkout can prove.
 *
 * The old one asked whether the shared registry NAMED the topic a producer emits. It never fired
 * and never could have: every record it watched described a topic a live producer emits and no
 * registry names, which is the state it read as "still true". Five records sat here for weeks
 * saying a notification was impossible while trade, market and devplatform were emitting the exact
 * names this service had written down.
 *
 * This asks the question notify owns instead: does this service's own rule table contradict the
 * record? Writing the rule now deletes the record, which is the failure mode the five had. The
 * cross-repository half — is a producer emitting it at all — belongs to micro-org's
 * tools/estate-topics.mjs, which is the only checkout that can see both halves, and is what found
 * these. Neither half pretends to do the other's job.
 */
test('a recorded gap disappears once this service writes the rule it said was impossible', () => {
  assert.deepEqual(
    contradictedGaps(),
    [],
    'a rule exists for the topic this record says cannot be notified on — delete the record',
  )
})

/**
 * The three rules the five stale records were hiding, driven with the producer's REAL payload.
 *
 * A rule that resolves no recipient is as dead as no rule, and two of the five turned out to be
 * exactly that — their records stayed, with the reason. These three must therefore be shown to
 * address somebody from the shape the producer actually emits, copied field for field from the
 * emit site named in each quarantine entry. Asserting `hasRule` alone would repeat the mistake the
 * whole file exists to stop: counting a rule as coverage without ever running it.
 *
 * All three are REGISTERED now — micro-contracts pasted the quarantined specs into the registry
 * within the hour — so the quarantine assertions here have flipped: each must be in the registry
 * and must NOT be in `AWAITING_REGISTRATION`, which is the deletion `adoptedProposals()` demanded.
 * The payload half of the test is unchanged, because that is the half that proves the rule works.
 */
test('each newly live rule addresses a real recipient from the payload its producer really sends', () => {
  const cases = [
    {
      // trade/src/bots.ts — payload { botId }, actor the bot's OWNER.
      topic: 'trade.bot.paused',
      payload: { botId: 'bot-1' },
      actor: `user:${ALICE}`,
      dedupeKey: 'trading.bot_paused:bot-1',
    },
    {
      // devplatform's `emitKeyIssued` — the display and the project, never the key, and the actor
      // is the caller: `user:<id>` for a session, which under a stolen session IS the victim's id.
      topic: 'devplatform.key.issued',
      payload: { keyId: 'key-1', projectId: 'p-1', environment: 'live', display: 'cfk_live_abc', scopes: [] },
      actor: `user:${ALICE}`,
      dedupeKey: 'api.key_issued:key-1',
    },
    {
      topic: 'devplatform.key.revoked',
      payload: { keyId: 'key-1', projectId: 'p-1', environment: 'live', display: 'cfk_live_abc', lookupId: 'abc', reason: '' },
      actor: `user:${ALICE}`,
      dedupeKey: 'api.key_revoked:key-1',
    },
  ] as const

  for (const each of cases) {
    assert.equal(hasRule(each.topic), true, `${each.topic} has no rule`)
    assert.equal(isRegisteredTopic(each.topic), true, `${each.topic} was adopted by contracts`)
    assert.equal(
      Object.hasOwn(AWAITING_REGISTRATION, each.topic),
      false,
      `${each.topic} is registered AND quarantined — the quarantine entry is the thing to delete`,
    )

    // Still assembled by hand rather than by `makeEvent`: the payloads below are the producers'
    // real shapes, and building them through the registry would only prove the registry agrees
    // with itself. `unregisteredEvent` is a plain envelope builder, not a claim about the topic.
    const event = unregisteredEvent(each.topic, 'k-1', { ...each.payload }, { actor: each.actor })
    const set = RULES[each.topic]?.recipients(event)
    assert.equal(set?.kind, 'recipients', `${each.topic} resolves nobody from what its producer sends`)
    if (set?.kind !== 'recipients') continue
    assert.equal(set.recipients.length, 1)
    assert.equal(set.recipients[0].userId, ALICE)
    assert.equal(set.recipients[0].dedupeKey, each.dedupeKey, 'keyed on the domain id, never on the event id')
  }

  // And an envelope with no user anywhere is no_recipient rather than a guess. devplatform emits
  // under two such actors today: `service:<display>` when a key mints a key, and `service:identity`
  // when the organisation-erasure path revokes every key an organisation holds. Both are legal
  // envelopes naming no person, and both must resolve nobody rather than somebody.
  for (const actor of ['service:cfk_live_abcd1234', 'service:identity'] as const) {
    const anonymous = unregisteredEvent(
      'devplatform.key.revoked',
      'k-1',
      { keyId: 'key-1', projectId: 'p-1' },
      { actor },
    )
    assert.deepEqual(
      RULES['devplatform.key.revoked']?.recipients(anonymous),
      { kind: 'none', reason: 'no_recipient' },
      `${actor} resolved a recipient — telling the wrong person their credentials changed`,
    )
  }
})

/**
 * THE PREDICTION THIS SERVICE MADE, KEPT AS A PROPERTY INSTEAD OF AS PROSE.
 *
 * `catalogue.ts` carried a note naming two actor spellings devplatform was emitting —
 * `key:<display>` for an API-key caller and `system:identity` on the organisation-erasure path —
 * and called them "a producer to fix". It was right, and it understated the fault: neither spelling
 * is a legal `Actor`, so every envelope on both paths was one the estate refuses outright. They
 * were invisible only because `activity` quarantined their (then unregistered) topic without
 * validating the envelope.
 *
 * The note also cited `devplatform/src/server.ts` and, and both citations were stale
 * within the hour the defects were fixed. That is what a cross-repository `path:line` claim always
 * does, and it is why the record is kept HERE instead: the fault was never at a line number, it was
 * a contract violation, and the contract is a dependency this repository's CI actually resolves.
 * `micro-devplatform` is not checked out by `service-ci.yml`, so a content pin into it could only
 * ever skip — and a check that always skips is the same as no check with a better reputation.
 */
test('the two illegal actor spellings can never come back', () => {
  for (const spelling of ['key:cfk_live_abcd1234', 'system:identity']) {
    const parsed = parseActor(spelling)
    assert.equal(parsed.ok, false, `${spelling} is a legal actor again — the contract widened`)
  }
  // `system` bare is legal and carries no subject, which is exactly why `system:identity` is not:
  // parseActor matches the bare word first and then refuses `system` as an unknown KIND.
  assert.equal(parseActor('system').ok, true)
  // And the corrected spellings devplatform emits today are legal, or the repair traded one
  // refused envelope for another.
  for (const spelling of ['service:cfk_live_abcd1234', 'service:identity', `user:${ALICE}`]) {
    assert.equal(parseActor(spelling).ok, true, `${spelling} is refused by the contract`)
  }

  // And notify's own behaviour for each, which is the half a contract cannot state. An illegal
  // actor must read as "no recipient" and never throw: a rule that threw would turn a delivered
  // event into a failed delivery and a redelivery loop.
  for (const actor of ['key:cfk_live_abcd1234', 'system:identity', 'system', 'user:'] as const) {
    const event = unregisteredEvent(
      'devplatform.key.issued',
      'k-1',
      { keyId: 'key-1', projectId: 'p-1', display: 'cfk_live_abcd1234' },
      { actor: actor as Actor },
    )
    assert.deepEqual(
      RULES['devplatform.key.issued']?.recipients(event),
      { kind: 'none', reason: 'no_recipient' },
      `${actor} must resolve nobody rather than somebody`,
    )
  }
})

/**
 * **Both original `no-subject` records closed, within an hour of each other, and neither by this
 * service.**
 *
 * The pair were the two that survived the purge of the five: real events from live producers whose
 * envelopes named nobody notify could address. Each needed ONE FIELD from a producer, each got it,
 * and each record then contradicted a rule in this repository's own catalogue — which is what
 * `contradictedGaps()` fails on, so the repair could not leave the record behind.
 *
 *   - `settlement.outbound.failed` — `userId`, settlement/src/withdrawals.ts.
 *   - `market.offer.made` — `sellerSubject`, market/src/bids.ts.
 *
 * That is the lesson worth keeping: `blockedBy: 'no-subject'` is the most PERISHABLE state a record
 * can be in, because the repair is a field rather than a design. Both were written as though they
 * would stand for weeks and both were false in hours.
 *
 * ## The blanket assertion that used to be here, and why it had to go
 *
 * This test opened with `filter(blockedBy === 'no-subject')` deep-equalling `[]` — "no such record
 * may exist". It was true for about three hours, and it was **an incentive to hide a gap**: the
 * next author to find a producer naming only its actor had the choice of recording it and turning
 * this suite red, or saying nothing. Two more instances arrived that same night, from `tessera`,
 * a producer that did not exist when the sentence was written. A guard that fails on an honest
 * record and passes on an omission is pointed the wrong way round, which is the same criticism
 * this file's own `staleGaps()` earned.
 *
 * What replaces it is narrower and can actually fail: the two named closures are pinned by name,
 * and every SURVIVING `no-subject` record must be visible in both of the places a reader looks —
 * no rule (or `contradictedGaps()` would fail), and an entry in `NON_NOTIFYING_TOPICS` explaining
 * itself, so the topic is accepted at `/ingest` and appears in the coverage table rather than
 * being silently unmapped. That pairing is the state `settlement.outbound.failed` was in while it
 * was blocked, and the previous version of this test asserted none of it.
 */
test('every no-subject record that a producer has since fixed is gone', () => {
  for (const gap of UNPRODUCED_NOTIFICATIONS.filter((each) => each.blockedBy === 'no-subject')) {
    const topic = gap.emits ?? ''
    assert.equal(hasRule(topic), false, `${topic} has both a rule and a no-subject record`)
    assert.ok(
      Object.hasOwn(NON_NOTIFYING_TOPICS, topic),
      `${topic} is recorded as blocked but is invisible to the coverage table — add the reason`,
    )
    assert.equal(isKnownTopic(topic), true, `${topic} must still be accepted at /ingest`)
    assert.match(
      NON_NOTIFYING_TOPICS[topic] ?? '',
      /DEFERRED/,
      `${topic}'s NON_NOTIFYING reason reads as a decision while its record calls it a deferral`,
    )
  }
  for (const topic of ['settlement.outbound.failed', 'market.offer.made']) {
    assert.equal(hasRule(topic), true, `${topic} named a subject; the rule it was owed is missing`)
    assert.equal(isKnownTopic(topic), true, `${topic} must be accepted at /ingest`)
    assert.equal(
      Object.hasOwn(NON_NOTIFYING_TOPICS, topic),
      false,
      `${topic} is both mapped and recorded as not notifying`,
    )
  }
  // market's was ahead of the registry for about two hours, quarantined with the spec that would
  // register it — the legitimate state AWAITING_REGISTRATION exists to make visible rather than an
  // invisible one. `micro-contracts` 5e0d11a pasted that spec, `adoptedProposals()` turned this
  // suite red, and the entry is deleted. Both topics are registered now, and BOTH are asserted:
  // this is the assertion that was inverted by the registration, so it is the one that proves the
  // deletion happened rather than the quarantine quietly keeping an adopted entry.
  assert.equal(isRegisteredTopic('market.offer.made'), true)
  assert.equal(Object.hasOwn(AWAITING_REGISTRATION, 'market.offer.made'), false)
  assert.equal(isRegisteredTopic('settlement.outbound.failed'), true)
})

/**
 * The record that closed, checked from both ends.
 *
 * `settlement.outbound.failed` was a `no-subject` record and it is now a rule, because settlement
 * put `userId` on the payload (`settlement/src/withdrawals.ts`). Three things had to move
 * together, and a test that checked only one would let the other two rot:
 *
 *   1. the rule exists — otherwise the notification is still missing;
 *   2. the `UNPRODUCED_NOTIFICATIONS` record is gone — `contradictedGaps()` fails while both stand,
 *      and that is the property the five deleted records did not have;
 *   3. the `NON_NOTIFYING_TOPICS` entry is gone — it said the envelope names nobody, which is now
 *      false, and a registered topic may be mapped OR recorded, never both.
 */
test('the failed-withdrawal record is gone from every place that claimed the gap', () => {
  assert.equal(hasRule('settlement.outbound.failed'), true, 'the rule the record said was impossible')
  assert.equal(isRegisteredTopic('settlement.outbound.failed'), true)
  assert.equal(isKnownTopic('settlement.outbound.failed'), true)
  assert.equal(
    UNPRODUCED_NOTIFICATIONS.some((each) => each.emits === 'settlement.outbound.failed'),
    false,
    'a record saying this cannot be notified on, beside the rule that notifies on it',
  )
  assert.equal(
    Object.hasOwn(NON_NOTIFYING_TOPICS, 'settlement.outbound.failed'),
    false,
    'both mapped and recorded as not notifying — the coverage table can only mean one of them',
  )
  // And the requirement it carried has not been dropped on the floor along with the record: the
  // AD-08 coverage test in catalogue.test.ts now lists this topic as live.
  assert.equal(
    UNPRODUCED_NOTIFICATIONS.some(
      (each) => each.requirement === 'withdrawal transaction failed outright',
    ),
    false,
  )
})

/**
 * The two tessera deferrals, checked the same four ways — and one more the other two did not need.
 *
 * These were the third and fourth `no-subject` records this service wrote, and they closed the same
 * way the first two did: `micro-tessera` 33ead39 added `ownerSubject` to both payloads, read off
 * the `parcels` row the emitting transaction already held `for update`. Four things had to move
 * together for each, and a test that checked only `hasRule` would let the other three rot:
 *
 *   1. the rule exists;
 *   2. the `UNPRODUCED_NOTIFICATIONS` record is gone — `contradictedGaps()` fails while both stand;
 *   3. the `NON_NOTIFYING_TOPICS` entry is gone — it said the envelope names nobody, now false;
 *   4. the requirement is not silently dropped with the record.
 *
 * The fifth is what makes this different from the withdrawal's. Those two records were closed by a
 * field that was already the only person on the envelope. **These two were closed by a field that
 * competes with one already there** — `challengerSubject` and `bookedBy`, both live, both users,
 * both wrong — so the rule can be perfectly reachable and still address the wrong person. That is a
 * property of the RULE and not of the tables, so it is asserted where the payload is:
 * `catalogue.test.ts`, "notifies the OWNER … never the challenger/booker who …", each fed
 * yesterday's shape first.
 */
test('the tessera deferrals are gone from every place that claimed the gap', () => {
  for (const topic of ['tessera.parcel.fallowed', 'tessera.venue.booked']) {
    assert.equal(hasRule(topic), true, `${topic}: the rule the record said was impossible`)
    assert.equal(isRegisteredTopic(topic), true)
    assert.equal(isKnownTopic(topic), true)
    assert.equal(
      UNPRODUCED_NOTIFICATIONS.some((each) => each.emits === topic),
      false,
      `${topic}: a record saying this cannot be notified on, beside the rule that notifies on it`,
    )
    assert.equal(
      Object.hasOwn(NON_NOTIFYING_TOPICS, topic),
      false,
      `${topic}: both mapped and recorded as not notifying — the table can only mean one of them`,
    )
    assert.equal(
      Object.hasOwn(AWAITING_REGISTRATION, topic),
      false,
      `${topic}: registered by contracts 41751b1; a quarantine entry would be an adopted one kept`,
    )
  }
  for (const requirement of ['your parcel is being contested', 'somebody booked your venue']) {
    assert.equal(
      UNPRODUCED_NOTIFICATIONS.some((each) => each.requirement === requirement),
      false,
      `${requirement}: the record is gone but the requirement went with it`,
    )
  }
  // And nothing is blocked on a subject any more. Every `no-subject` record this service has ever
  // written — four of them — was closed by its producer adding one field off a row the emitting
  // transaction already held, and not one by this service inventing a recipient. An empty set here
  // is the claim; if a fifth is ever written, this line is what has to be edited to say so.
  assert.deepEqual(
    UNPRODUCED_NOTIFICATIONS.filter((each) => each.blockedBy === 'no-subject').map((each) => each.emits),
    [],
    'a new no-subject record — name it here, and name the producer that owes the field',
  )
})

/**
 * The rules the registration wave made reachable.
 *
 * Each was mapped here and emitted by a live producer while the registry named neither, so each
 * was a written, signed, delivered event that every consumer refused. Registering the topic is
 * what turns the existing rule on.
 */
test('the topics registered from a live producer are the ones this service already mapped', () => {
  for (const topic of [
    'identity.mfa.added',
    'wallet.wallet.created',
    'community.proposal.opened',
    'community.vote.cast',
  ]) {
    assert.equal(isRegisteredTopic(topic), true, `${topic} is emitted today`)
    assert.equal(hasRule(topic), true, `${topic} has a rule and can now fire`)
  }
})

test('the password-change notification is keyed to the event identity really emits', () => {
  // identity announces no password change; it revokes every session with a reason
  // (identity/src/server.ts). §10.3's password-change entry rides that event or it does not
  // exist at all, which is what it did for the whole life of this service.
  assert.equal(hasRule('identity.session.revoked'), true)
  assert.equal(isRegisteredTopic('identity.session.revoked'), true)
  assert.equal(RULES['identity.session.revoked']?.priority, 'critical')
  assert.equal(hasRule('identity.password.changed'), false)
})

test('a non-notifying reason is a decision, and only for topics that exist', () => {
  for (const [topic, reason] of Object.entries(NON_NOTIFYING_TOPICS)) {
    assert.equal(isRegisteredTopic(topic), true, `${topic} is not in the registry at all`)
    assert.ok(reason.length > 40, `${topic} needs a real reason, not a label`)
    assert.equal(hasRule(topic), false, `${topic} is both mapped and recorded as not notifying`)
  }
})

test('the quarantine is a rule-side escape hatch, not a rule-side exemption', () => {
  // Every quarantined topic must actually have a rule: the quarantine explains a rule that is
  // ahead of the registry, and an entry with no rule explains nothing.
  for (const topic of Object.keys(AWAITING_REGISTRATION)) {
    assert.equal(hasRule(topic), true, `${topic} is quarantined but this service has no rule for it`)
  }
})

/**
 * micro-org#235, applied to the file that invites the defect. **No comment in this service's own
 * modules cites a line number, in anybody's file or in its own.**
 *
 * A rule about comments, asserted, which needs a justification because most comment rules do not
 * deserve one. This one is measured. Before this test there were seventeen `path.ts` + line
 * citations across `catalogue.ts`, `topics.ts` and this repository's own `pipeline.ts`, and on
 * 2026-08-11 **fifteen of them pointed at something other than what they claimed**: the number on
 * `trade/src/bots.ts` in the `trade.bot.paused` rule landed on an `idempotencyKey` inside
 * `startBot` rather than on the pause that leaves a position open; two landed on blank lines; the
 * pair cited for `settlement.outbound.confirmed` landed in a function that emits neither of the two
 * topics the sentence was about. The only two that still resolved were both into `micro-contracts`
 * — the one sibling this repository's CI checks out, and therefore the only repository whose drift
 * anything here could ever have noticed.
 *
 * That is exactly the shape #235 describes: a cross-repo citation is a claim no test can see go
 * wrong, so it goes wrong silently and then argues for the wrong thing. The `why` on
 * `trade.bot.paused` was using its stale number to argue a priority.
 *
 * A symbol cannot drift that way — it moves with the code it names and is greppable from either end
 * — and quoting the producer's own sentence beside it makes the claim checkable by reading two
 * files rather than by trusting an offset. Both are what the citations here now do.
 *
 * **The test files are excluded, and that is a real hole rather than a tidy one.** This comment has
 * to be able to quote the offenders it exists because of, and a scan that included itself could not
 * say what it found. The service modules are where a citation does damage, because that is where
 * one argues for a priority, a template or a decision not to notify.
 *
 * Reading the source rather than inspecting comments some cleverer way follows `catalogue.test.ts`,
 * "the sentence #221 is about is gone from the service": a property about what is WRITTEN in this
 * repository is checked by reading what is written in this repository.
 */
test('no comment in this service cites a line number in any file', () => {
  const dir = new URL('./', import.meta.url)
  const modules = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
  /*
   * ── THE VACUOUS-GREEN GUARD, AND WHY IT NAMES FILES SINCE WAVE M2 ─────────────────────────────
   *
   * `> 15` is a floor and this scan is `./` relative to THIS file, so the merge moved it from
   * `notify/src/` to `activity/src/notify/` and it followed correctly. That is luck rather than
   * design: a scanner that had lost the sources would report an empty offender set, which is
   * byte-for-byte what a clean repository reports.
   *
   * The count itself legitimately CHANGED — 21 modules to 20. `index.ts` and `migrator.ts` are the
   * two entry-point scripts a module in somebody else's process does not have, and `module.ts` is
   * the seam that replaced them. So the floor cannot be pinned to a number without pinning a fact
   * about packaging. The files below are pinned instead: they are the ones where a path-and-line
   * citation does damage, because that is where one argues for a priority, a template or a
   * decision not to notify.
   */
  assert.ok(modules.length > 15, `the scan found ${modules.length} modules — it is passing vacuously`)
  for (const expected of ['catalogue.ts', 'topics.ts', 'templates.ts', 'pipeline.ts', 'module.ts']) {
    assert.ok(
      modules.includes(expected),
      `${expected} is not in the scanned set — the scan has lost the source it exists to read`,
    )
  }
  const offenders: string[] = []
  for (const name of modules) {
    readFileSync(new URL(name, dir), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // `.ts` followed by a colon and a digit. Deliberately not restricted to comment lines: a
        // citation is no better inside a string literal, and `NON_NOTIFYING_TOPICS` is a table of
        // string literals that carried three of them.
        if (/\.ts:\d/.test(line)) offenders.push(`${name} line ${index + 1}`)
      })
  }
  assert.deepEqual(
    offenders,
    [],
    'a path-and-line citation — name the symbol and quote what it says instead (micro-org#235)',
  )
})
