/**
 * Everything that needs no database.
 *
 * The first two tests are the ones that keep this service honest against its two contracts. The
 * categories must be exactly the sixteen 04-domain-model §10.1 names — they are a filter menu the
 * frontend derives from this list, so a seventeenth is a product decision and not a place to put
 * an event nobody classified. And every topic in `@cloudsforge/contracts-events` must have a
 * classifier, because AD-11 says activity subscribes to *every* domain topic and a table that
 * silently missed one would quarantine that product's whole history.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOPICS,
  TOPIC_NAMES,
  makeEvent,
  serialiseEvent,
  signDelivery,
  verifyDelivery,
  type Actor,
  type TopicName,
} from '@cloudsforge/contracts-events'
import { RETIRED_ASSETS } from '@cloudsforge/contracts-chain'
import { CATEGORIES, STORED_CATEGORIES, UNCLASSIFIED, isCategory } from './categories.ts'
import { CLASSIFIED_TOPICS, CLASSIFIERS, classify, subjectUrnFor } from './classify.ts'
import { BadCursorError, decodeCursor, encodeCursor } from './records.ts'
import { MalformedEventError, parseDelivery } from './ingest.ts'
import { ALICE, BOB, SECRET, delivery, unknownTopicDelivery } from './testsupport.ts'

/* ------------------------------------------------------------------ contracts */

test('THE RULE: the categories are exactly the sixteen in 04-domain-model §10.1', () => {
  assert.deepEqual(CATEGORIES, [
    'account',
    'security',
    'wallet',
    'deposit',
    'withdrawal',
    'transfer',
    'conversion',
    'token',
    'ownership',
    'trading',
    'market',
    'reward',
    'community',
    'governance',
    'api',
    'billing',
  ])
  assert.equal(CATEGORIES.length, 16)
  // `unclassified` is a seventeenth stored value and deliberately not one of the sixteen: it is a
  // quarantine, not a part of the product's vocabulary.
  assert.equal(isCategory(UNCLASSIFIED), false)
  assert.equal(STORED_CATEGORIES.length, 17)
})

test('THE RULE: every registered topic has a classifier', () => {
  // The table is declared `satisfies Readonly<Record<TopicName, TopicClassifier>>`, so this is
  // already a compile error — asserted at runtime too, because a compile-time guarantee is only
  // as good as the next person's `as`.
  assert.deepEqual([...CLASSIFIED_TOPICS].sort(), [...TOPIC_NAMES].sort())
  for (const topic of TOPIC_NAMES) {
    assert.ok(isCategory(CLASSIFIERS[topic].category), `${topic} maps outside the sixteen`)
  }
})

/* ------------------------------------------------------------------ classification */

test('a known event is classified, attributed and summarised', () => {
  const { envelope } = delivery({
    topic: 'wallet.deposit.confirmed',
    key: 'wallet-1',
    // The pair as wallet actually emits it (`wallet/src/deposits.ts`): the raw smallest
    // units AND the decimal figure wallet converted with the asset's `decimals`. The fixture used
    // to carry `amount: '25.5'` alone, which is a payload wallet has never sent — 25.5 of a
    // SHARD's indivisible units is 2.55e-17 SHARD, and asserting on it proved nothing.
    payload: { userId: ALICE, amount: '25500000000000000000', amountFormatted: '25.5', assetCode: 'SHARD' },
  })
  const classified = classify(envelope, true)
  assert.equal(classified.category, 'deposit')
  assert.equal(classified.type, 'deposit.confirmed')
  assert.equal(classified.userId, ALICE)
  assert.equal(classified.amount, '25.5')
  assert.equal(classified.assetCode, 'SHARD')
  assert.equal(classified.visibility, 'user')
  // Referenced by URN, not by a foreign key. 04-domain-model §11: no cross-service foreign keys.
  assert.equal(classified.subjectUrn, 'urn:cloudsforge:wallet:deposit:wallet-1')
  assert.match(classified.summary, /25\.5 SHARD/)
})

test('THE RULE: an unknown topic is quarantined, not dropped', () => {
  const { envelope } = unknownTopicDelivery()
  const classified = classify(envelope, false)
  assert.equal(classified.category, UNCLASSIFIED)
  assert.equal(classified.type, 'worlds.session.ended')
  // Internal, so nobody is shown a record nobody has classified — and no owner is guessed from a
  // payload whose schema this build has never seen.
  assert.equal(classified.visibility, 'internal')
  assert.equal(classified.userId, null)
  assert.match(classified.summary, /does not yet classify/)
})

test('THE RULE: a topic the REGISTRY knows and this build cannot classify is quarantined, not a crash', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The regression test for the production 500, and it is deliberately not a test about five
  // wallet topics — those are classified now, and a test naming them would go green for ever the
  // moment they were added while leaving the mechanism exactly as broken for the next five.
  //
  // What crashed: `known` is computed from the REGISTRY (`ingest.ts`), not from this build's
  // table, so a topic `@cloudsforge/contracts-events` had registered and `classify.ts` had no
  // entry for arrived with `known === true`, took the classified branch, and dereferenced
  // `undefined` —
  //
  //     TypeError: Cannot read properties of undefined (reading 'payloadKeys')
  //
  // — which is a 500 on `POST /ingest`, a delivery the relay retries for ever, and a feed that
  // stops moving. `known: true` below IS that state, expressed in the one line that produces it:
  // a topic with no classifier, asserted to be known.
  //
  // This goes red again if the `TopicClassifier` cast is reinstated on the lookup. That is the
  // point of it: the cast asserted the one thing that was false, and `noUncheckedIndexedAccess`
  // cannot see through an assertion.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const { envelope } = unknownTopicDelivery('worlds.session.ended', { userId: ALICE, seconds: 90 })

  // The premise, stated rather than assumed: this topic really has no classifier. If somebody
  // classifies `worlds.session.ended` one day, this line fails loudly instead of the test quietly
  // measuring nothing.
  assert.ok(!CLASSIFIED_TOPICS.includes(envelope.topic), 'the fixture topic must have no classifier')

  const classified = classify(envelope, true)

  assert.equal(classified.category, UNCLASSIFIED)
  assert.equal(classified.type, 'worlds.session.ended')
  assert.equal(classified.visibility, 'internal')
  // No owner is guessed off a schema this build has never seen, even though `userId` is sitting
  // right there in the payload and would parse.
  assert.equal(classified.userId, null)
  assert.match(classified.summary, /does not yet classify/)
  // Kept, not dropped: the row is reclassifiable from data that was never thrown away, which is
  // the entire reason quarantine beats a 500.
  assert.equal(classified.payload['userId'], ALICE)
  assert.equal(classified.payload['seconds'], 90)
  assert.equal(classified.subjectUrn, `urn:cloudsforge:worlds:session:${ALICE}`)

  // And the same for `known: false`, so the two paths cannot drift into disagreeing about what a
  // quarantined record looks like.
  assert.deepEqual(classify(envelope, false), classified)
})

test('a record with no owner is internal, whatever its classifier says', () => {
  // `settlement.withdrawal.stuck` is keyed by chain:network and may carry no user. Without this,
  // it would be a `user`-visible record that no user can ever see, which reads on a dashboard as
  // a delivered notification.
  const { envelope } = delivery({ topic: 'settlement.withdrawal.stuck', key: 'ethereum:mainnet' })
  assert.equal(CLASSIFIERS['settlement.withdrawal.stuck'].visibility, 'user')
  assert.equal(classify(envelope, true).visibility, 'internal')
})

test('a payload string is capped before it reaches a summary', () => {
  // A summary is rendered in a user's feed, and a producer's field may hold user input. Capping
  // at the point of use is the only version of this that survives a producer changing its mind.
  const { envelope } = delivery({
    topic: 'mint.deploy.confirmed',
    key: 'token-1',
    payload: { userId: ALICE, name: 'A'.repeat(500), contractAddress: '0xabc' },
  })
  const classified = classify(envelope, true)
  assert.ok(classified.summary.length < 200, `summary was ${classified.summary.length} characters`)
  assert.match(classified.summary, /…/)
})

test('an entitlement keyed by an organisation has no single owner and stays internal', () => {
  const { envelope } = delivery({ topic: 'billing.entitlement.granted', key: 'org:acme', payload: { scope: 'worlds' } })
  const classified = classify(envelope, true)
  assert.equal(classified.userId, null)
  assert.equal(classified.visibility, 'internal')
})

test('the subject URN names the owning service and never another', () => {
  assert.equal(subjectUrnFor('custody', 'key', 'k-1'), 'urn:cloudsforge:custody:key:k-1')
})

test('a battle report lands in the DEFENDER\'s feed — never the raider\'s', () => {
  // aetherholm.battle.resolved is keyed by battle id and its ACTOR is the attacker
  // (aetherholm/src/fleets.ts, the `user:` actor on the emit). Both parties are in the payload;
  // the record is the defender's news. Reading key or actor here would file "your city was
  // raided" in the raider's feed — the session.created misattribution, with a cannon.
  const { envelope } = delivery({
    topic: 'aetherholm.battle.resolved',
    key: '018f0000-0000-7000-8000-00000000b001',
    payload: {
      attackerUserId: BOB,
      defenderUserId: ALICE,
      cityName: 'Aerie',
      outcome: 'raided',
    },
  })
  const classified = classify(envelope, true)
  assert.equal(classified.userId, ALICE)
  assert.equal(classified.visibility, 'user')
  assert.match(classified.summary, /Aerie was raided/)
  // A repelled attack reads as the defender's win, same owner.
  const repelled = delivery({
    topic: 'aetherholm.battle.resolved',
    key: '018f0000-0000-7000-8000-00000000b002',
    payload: { attackerUserId: BOB, defenderUserId: ALICE, cityName: 'Aerie', outcome: 'repelled' },
  })
  assert.match(classify(repelled.envelope, true).summary, /repelled/)
})

test('an alliance-held spire has no single owner and stays internal; a lone holder owns it', () => {
  const alliance = delivery({
    topic: 'aetherholm.spire.captured',
    key: '018f0000-0000-7000-8000-00000000c001',
    payload: { allianceId: '018f0000-0000-7000-8000-00000000d001', allianceName: 'Windward', userIds: [ALICE, BOB] },
  })
  const classifiedAlliance = classify(alliance.envelope, true)
  assert.equal(classifiedAlliance.userId, null)
  assert.equal(classifiedAlliance.visibility, 'internal')

  const solo = delivery({
    topic: 'aetherholm.spire.captured',
    key: '018f0000-0000-7000-8000-00000000c002',
    payload: { holderUserId: ALICE, userIds: [ALICE] },
  })
  const classifiedSolo = classify(solo.envelope, true)
  assert.equal(classifiedSolo.userId, ALICE)
  assert.equal(classifiedSolo.visibility, 'user')
})

/* ------------------------------------------------------------------ the five */

test('a plain sign-out and a security revocation are not the same entry', () => {
  // The whole reason `identity.session.revoked` carries a `reason`. notify fires a CRITICAL
  // notification for every reason except `signed_out` (notify/src/catalogue.ts); a timeline
  // that read both the same way would contradict the alert the user just received.
  const session = '33333333-3333-4333-8333-333333333333'
  const revoked = (reason: string) =>
    classify(delivery({ topic: 'identity.session.revoked', key: session, payload: { sessionId: session, userId: ALICE, reason } }).envelope, true)

  const plain = revoked('signed_out')
  assert.equal(plain.type, 'security.signed_out')
  assert.equal(plain.summary, 'You signed out.')

  const burned = revoked('password_reset')
  assert.equal(burned.type, 'security.session_revoked')
  assert.match(burned.summary, /password was reset/)
  assert.notEqual(burned.type, plain.type)

  // A reason this build has never seen — the refresh-family burn at identity/src/server.ts has
  // no constant — must fall through to the ALARMING sentence, never the reassuring one.
  const unknown = revoked('refresh_token_reuse')
  assert.equal(unknown.type, 'security.session_revoked')
  assert.match(unknown.summary, /change your password/)
  assert.doesNotMatch(unknown.summary, /You signed out\./)

  // And it is the user's own record, not the session id's. The key IS a uuid, so a userFromKey
  // reader would have returned the SESSION id here and filed every revocation in nobody's feed.
  assert.equal(plain.userId, ALICE)
  assert.equal(plain.visibility, 'user')
})

test('an MFA factor added reads differently when it replaced one', () => {
  const added = (payload: Record<string, unknown>) =>
    classify(delivery({ topic: 'identity.mfa.added', key: ALICE, payload }).envelope, true)

  const fresh = added({ kind: 'totp', replacedPrevious: false, remainingActive: 2 })
  assert.equal(fresh.category, 'security')
  assert.equal(fresh.userId, ALICE) // keyed by user_id — identity/src/mfa.ts:566
  assert.match(fresh.summary, /added to your account/)
  assert.match(fresh.summary, /totp/)

  assert.match(added({ kind: 'totp', replacedPrevious: true }).summary, /replaced/)
})

test('a wallet created reads as a link when the user brought their own', () => {
  const created = (payload: Record<string, unknown>) =>
    classify(delivery({ topic: 'wallet.wallet.created', key: '44444444-4444-4444-8444-444444444444', payload }).envelope, true)

  const custodial = created({ walletId: 'w-1', userId: ALICE, origin: 'custodial', chain: 'ethereum', network: 'mainnet' })
  assert.equal(custodial.category, 'wallet')
  // Keyed by WALLET id, so the user comes off the payload — wallet/src/wallets.ts.
  assert.equal(custodial.userId, ALICE)
  assert.match(custodial.summary, /created for you/)
  assert.match(custodial.summary, /ethereum mainnet/)

  const external = created({ walletId: 'w-2', userId: ALICE, origin: 'external', chain: 'ethereum', network: 'mainnet' })
  assert.match(external.summary, /linked to your account/)
  assert.notEqual(external.summary, custodial.summary)
})

test('a proposal opening belongs to no one, and a vote belongs to its voter', () => {
  const proposal = '55555555-5555-4555-8555-555555555555'

  // No user anywhere on the emit (community/src/jobs.ts — actor `service:community`,
  // payload `{ proposalId, communityId }`). Guessing an owner would file a community-wide fact in
  // one member's feed; notify is what fans it out to the membership.
  const opened = classify(
    delivery({ topic: 'community.proposal.opened', key: proposal, payload: { proposalId: proposal, communityId: 'c-1' } }).envelope,
    true,
  )
  assert.equal(opened.category, 'governance')
  assert.equal(opened.userId, null)
  assert.equal(opened.visibility, 'internal')

  // The receipt. The owner field is `voter`, holding `user:<uuid>` — NOT `userId`, and not a bare
  // uuid. A reader that assumed either would put "was my vote counted" in nobody's feed.
  const cast = classify(
    delivery({
      topic: 'community.vote.cast',
      key: proposal,
      payload: { proposalId: proposal, communityId: 'c-1', voter: `user:${ALICE}`, choice: 'for', subjectsCounted: 4 },
    }).envelope,
    true,
  )
  assert.equal(cast.category, 'governance')
  assert.equal(cast.userId, ALICE)
  assert.equal(cast.visibility, 'user')
  assert.match(cast.summary, /\(for\)/)
  // A delegate who expected to carry delegators and reads "1" has found a problem worth reporting.
  assert.match(cast.summary, /counted for 4 members/)
})

/* ------------------------------------------------------------------ settlement's three */

/** A withdrawal id and a sweep source id are both `uuid` columns — which is the whole trap. */
const WITHDRAWAL = '66666666-6666-4666-8666-666666666666'
const SWEEP_SOURCE = '77777777-7777-4777-8777-777777777777'

test('THE RULE: no classifier may return its own event KEY as the user, for any topic not keyed by one', () => {
  // The estate-wide form of the `identity.session.created` bug, and the reason it is a loop rather
  // than three assertions: that bug shipped because a SESSION id is a well-formed uuid, so
  // `userFromKey` returned it, `UUID_PATTERN` was satisfied, and every sign-in was filed against a
  // user that does not exist — silently, because a wrong uuid queries exactly as cleanly as a right
  // one. It then happened a second time with `identity.session.revoked`. Settlement's three are all
  // keyed by a uuid that is not a user (`withdrawal_id`, `withdrawal_id`, `sweep_source_id`), so
  // the same reader would have misfiled all three.
  //
  // The registry's `keyedBy` is the authority for which topics this applies to, so a topic
  // registered tomorrow with a non-user key is covered on the day it lands rather than when
  // somebody remembers to extend a list here.
  const KEY = '018f0000-0000-7000-8000-0000000000ff'
  const checked: string[] = []
  for (const topic of TOPIC_NAMES) {
    if (TOPICS[topic].keyedBy === 'user_id') continue
    checked.push(topic)
    // An empty payload: the producer has told us nothing but the key, which is exactly the
    // situation in which a key-reading classifier invents an owner.
    const { envelope } = delivery({ topic, key: KEY, payload: {} })
    const classified = classify(envelope, true)
    assert.notEqual(
      classified.userId,
      KEY,
      `${topic} is keyed by ${TOPICS[topic].keyedBy} and returned its key as the user`,
    )
  }
  // The loop must actually have run. A guard that silently checked nothing would pass for ever.
  assert.ok(checked.length > 20, `only ${checked.length} topics were checked`)
  assert.ok(checked.includes('settlement.outbound.confirmed'))
  assert.ok(checked.includes('settlement.outbound.failed'))
  assert.ok(checked.includes('settlement.sweep.completed'))
  // trade's and devplatform's three, keyed `bot_id`, `key_id`, `key_id` — three more uuids that
  // are not people. A bot id and an API key id are the same trap as a session id.
  assert.ok(checked.includes('trade.bot.paused'))
  assert.ok(checked.includes('devplatform.key.issued'))
  assert.ok(checked.includes('devplatform.key.revoked'))
})

/* ------------------------------------------------------------------ trade's one, devplatform's two */

const BOT = '88888888-8888-4888-8888-888888888888'
const API_KEY = '99999999-9999-4999-8999-999999999999'

/**
 * The three topics whose owner is on the ENVELOPE ACTOR, and nowhere else.
 *
 * Kept as a named list rather than inlined, because the rule below is written as its complement:
 * these three may read the actor, and no other topic may. A fourth topic added here without an
 * emit-site citation is the whole of the mistake this rule exists to make loud.
 */
const ACTOR_ATTRIBUTED: readonly TopicName[] = [
  'trade.bot.paused',
  'devplatform.key.issued',
  'devplatform.key.revoked',
]

test('THE RULE: only the three topics whose producer proves it may read the ACTOR as the user', () => {
  // The mirror of the key rule above, and it exists because the actor is the SECOND well-formed
  // wrong answer. The actor is who performed the act; the record belongs to whose news it is.
  // `aetherholm.battle.resolved` is the standing proof they differ — its actor is the RAIDER and
  // its record is the defender's — and `market`'s offer event had the same shape, which is why
  // notify refuses its own generic helper there. So: an envelope carrying a `user:` actor and
  // NOTHING else that names anybody must resolve to that actor for exactly three topics, and to
  // nobody for every other one. Switch any classifier to `userFromActor` and this goes red.
  const KEY = '018f0000-0000-7000-8000-0000000000fe'
  const permitted: string[] = []
  const refused: string[] = []
  for (const topic of TOPIC_NAMES) {
    // Empty payload: the producer has told us nothing but who acted, which is exactly the
    // situation in which an actor-reading classifier invents an owner.
    const { envelope } = delivery({ topic, key: KEY, payload: {}, actor: `user:${ALICE}` })
    const userId = classify(envelope, true).userId
    if (ACTOR_ATTRIBUTED.includes(topic)) {
      permitted.push(topic)
      assert.equal(userId, ALICE, `${topic} is actor-attributed and did not resolve its actor`)
    } else {
      refused.push(topic)
      assert.notEqual(
        userId,
        ALICE,
        `${topic} read its ACTOR as the user. The actor caused the event; it is not necessarily ` +
          'whose news it is. See aetherholm.battle.resolved.',
      )
    }
  }
  // Both halves must have run. A rule whose permitted list is empty, or whose refused list is,
  // passes for ever while measuring nothing.
  assert.deepEqual([...permitted].sort(), [...ACTOR_ATTRIBUTED].sort())
  assert.ok(refused.length > 20, `only ${refused.length} topics were held to the refusal`)
})

test('a paused bot reaches its owner — not the bot, and not whoever pressed the button', () => {
  const paused = (payload: Record<string, unknown>, actor: Actor) =>
    classify(delivery({ topic: 'trade.bot.paused', key: BOT, payload, actor }).envelope, true)

  // The payload trade really sends: `{ botId }` and nothing else (trade/src/bots.ts).
  const owned = paused({ botId: BOT }, `user:${ALICE}`)
  assert.equal(owned.category, 'trading')
  assert.equal(owned.type, 'trading.bot_paused')
  assert.equal(owned.userId, ALICE)
  assert.equal(owned.visibility, 'user')
  // Not the bot id. The key is a uuid, so a key reader hands back something that LOOKS like an
  // answer and files every pause against a bot dressed up as a person.
  assert.notEqual(owned.userId, BOT)
  // The sentence that makes the entry worth writing: pause is not a flatten, and an owner who
  // reads "your bot stopped" and believes they are flat is holding an open position.
  assert.match(owned.summary, /does not close its position/)
  assert.equal(owned.subjectUrn, `urn:cloudsforge:trade:bot:${BOT}`)

  // ── The two ways this could silently become the wrong person ─────────────────────────────
  //
  // 1. A `userFromPayload` reader. It returns null on the payload above, so a test written only
  //    against today's shape would go red — but it would go GREEN again the day trade widens the
  //    payload, and then quietly follow whatever field is called `userId`. So the reader's
  //    identity is pinned against a payload that names somebody ELSE: the actor wins, and a
  //    future widening cannot change the owner without a diff in classify.ts to blame.
  const contested = paused({ botId: BOT, userId: BOB }, `user:${ALICE}`)
  assert.equal(contested.userId, ALICE, 'the actor is the owner; a payload field must not override it')
  assert.notEqual(contested.userId, BOB)

  // 2. An actor that is not a person. `bots.ts` writes the OWNER's id off the row rather than
  //    the caller's, so this cannot happen today — but the day trade halts a bot itself, the entry
  //    must land in nobody's feed rather than in a guess. Internal, never a wrong feed.
  const halted = paused({ botId: BOT }, 'service:trade')
  assert.equal(halted.userId, null)
  assert.equal(halted.visibility, 'internal')
})

test('an API key issued lands in the feed of the person it can act as', () => {
  const issued = (actor: Actor, payload: Record<string, unknown> = {}) =>
    classify(
      delivery({
        topic: 'devplatform.key.issued',
        key: API_KEY,
        // devplatform/src/apikeys.ts — the display and the scopes, never the secret.
        payload: {
          keyId: API_KEY,
          projectId: '018f0000-0000-7000-8000-0000000000a1',
          environment: 'live',
          display: 'cfk_live_abcd1234',
          scopes: ['projects:read'],
          ...payload,
        },
        actor,
      }).envelope,
      true,
    )

  const byOwner = issued(`user:${ALICE}`)
  assert.equal(byOwner.category, 'api')
  assert.equal(byOwner.type, 'api.key_issued')
  assert.equal(byOwner.userId, ALICE)
  assert.equal(byOwner.visibility, 'user')
  assert.notEqual(byOwner.userId, API_KEY)
  // The display is the identifier an operator quotes at a revocation; the secret never leaves
  // devplatform and must never reach a feed.
  assert.match(byOwner.summary, /cfk_live_abcd1234/)
  assert.match(byOwner.summary, /without a password/)

  // A key minting a key authenticates as `service:<display>` (devplatform/src/server.ts). No
  // person acted, so no person is named — and the record is internal rather than a guess.
  const byMachine = issued('service:cfk_live_abcd1234')
  assert.equal(byMachine.userId, null)
  assert.equal(byMachine.visibility, 'internal')
  assert.equal(byMachine.type, 'api.key_issued', 'one fact: visibility already carries the difference')

  // The payload naming somebody else does not move the entry. Same pin as the bot above.
  assert.equal(issued(`user:${ALICE}`, { userId: BOB }).userId, ALICE)
})

test('a key revoked by its owner and a key revoked by the platform are two different facts', () => {
  const revoked = (actor: Actor, reason = '') =>
    classify(
      delivery({
        topic: 'devplatform.key.revoked',
        key: API_KEY,
        // devplatform/src/apikeys.ts.
        payload: {
          keyId: API_KEY,
          projectId: 'a1',
          environment: 'live',
          display: 'cfk_live_abcd1234',
          lookupId: 'abcd1234',
          reason,
        },
        actor,
      }).envelope,
      true,
    )

  // devplatform/src/server.ts — the owner's own DELETE. A receipt.
  const mine = revoked(`user:${ALICE}`, 'rotating')
  assert.equal(mine.category, 'api')
  assert.equal(mine.type, 'api.key_revoked')
  assert.equal(mine.userId, ALICE)
  assert.equal(mine.visibility, 'user')
  assert.match(mine.summary, /Reason given: rotating/)
  assert.doesNotMatch(mine.summary, /by CloudsForge/)

  // devplatform/src/server.ts — the identity.organisation.deleted handler revokes EVERY live
  // key the organisation holds, as `service:identity`. A company's whole production integration
  // stopping is not the same news as an engineer rotating one key, and a single static `type`
  // would hand a frontend one icon for both.
  const theirs = revoked('service:identity', 'organisation deleted')
  assert.equal(theirs.type, 'api.key_revoked_by_platform')
  assert.match(theirs.summary, /by CloudsForge/)
  assert.notEqual(theirs.type, mine.type)
  assert.notEqual(theirs.summary, mine.summary)

  // And it reaches nobody today, because there genuinely is no user on that envelope. Pinned as a
  // FACT rather than left implicit: it is the live gap this classifier reports to
  // micro-devplatform, and if devplatform puts the key's owner on the payload — or emits under an
  // `operator:`/`user:` actor — this assertion is what tells us the gap closed.
  assert.equal(theirs.userId, null)
  assert.equal(theirs.visibility, 'internal')
  // Specifically NOT the key id, which is the misattribution the uuid key invites.
  assert.notEqual(theirs.userId, API_KEY)

  // A key revoking a key is the same answer for the same reason.
  assert.equal(revoked('service:cfk_live_other').userId, null)
})

test('an actor spelling the contract refuses is not a user, and never throws', () => {
  // The two devplatform really shipped: `actorOf` spelled an API-key caller `key:<display>`, and
  // the organisation-erasure path passed `system:identity` — `system` is the one ActorKind that
  // takes no subject. Both are envelopes the estate refuses outright (see parseDelivery), so a
  // classifier should never meet one. If one ever reaches here it must read as "no user", never as
  // a throw: a classifier that threw would turn a delivered event into a 500 and a redelivery loop.
  for (const actor of ['key:cfk_live_abcd1234', 'system:identity', 'user:', 'user:not-a-uuid', 'system']) {
    const { envelope } = delivery({
      topic: 'devplatform.key.revoked',
      key: API_KEY,
      payload: { keyId: API_KEY, display: 'cfk_live_abcd1234' },
      actor: actor as Actor,
    })
    const classified = classify(envelope, true)
    assert.equal(classified.userId, null, `${actor} resolved to a user`)
    assert.equal(classified.visibility, 'internal')
    assert.equal(classified.type, 'api.key_revoked_by_platform')
  }
})

test('one payment does not become two feed entries: outbound.confirmed is internal, withdrawal.completed is the user\'s', () => {
  // `confirmedEvents` (settlement/src/withdrawals.ts) returns BOTH topics from one
  // `return [...]` behind one guard, for one row. Activity subscribes to every topic, so it gets
  // both. If the narrow one were attributed, a user would see "your withdrawal was sent" twice for
  // one payment — which reads as two withdrawals, and is worse than a missing entry because it is
  // a believable one.
  const narrow = classify(
    delivery({
      topic: 'settlement.outbound.confirmed',
      key: WITHDRAWAL,
      payload: { withdrawalId: WITHDRAWAL, txHash: '0xabc', confirmedAt: '2026-08-03T00:00:00.000Z' },
    }).envelope,
    true,
  )
  assert.equal(narrow.category, 'withdrawal')
  assert.equal(narrow.type, 'withdrawal.outbound_confirmed')
  assert.equal(narrow.userId, null)
  assert.equal(narrow.visibility, 'internal')

  // The refusal must survive settlement widening the payload. `userFromPayload` would have started
  // double-posting on that day with no diff in this repository to blame it on.
  const widened = classify(
    delivery({
      topic: 'settlement.outbound.confirmed',
      key: WITHDRAWAL,
      payload: { withdrawalId: WITHDRAWAL, userId: ALICE, txHash: '0xabc' },
    }).envelope,
    true,
  )
  assert.equal(widened.userId, null)
  assert.equal(widened.visibility, 'internal')

  // And the fact IS in the user's feed — under the other half of the same emit.
  const wide = classify(
    delivery({
      topic: 'settlement.withdrawal.completed',
      key: WITHDRAWAL,
      payload: { withdrawalId: WITHDRAWAL, userId: ALICE, amount: '25', assetCode: 'SHARD', transactionHash: '0xabc' },
    }).envelope,
    true,
  )
  assert.equal(wide.userId, ALICE)
  assert.equal(wide.visibility, 'user')
})

test('a failed withdrawal reads as two different facts, and the reassuring one is never the fallback', () => {
  const failed = (payload: Record<string, unknown>) =>
    classify(delivery({ topic: 'settlement.outbound.failed', key: WITHDRAWAL, payload }).envelope, true)
  const base = { withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'insufficient gas' }

  // `refundable: true` — wallet/src/withdrawals.ts transitions to `failed` and refunds.
  const refunded = failed({ ...base, refundable: true })
  assert.equal(refunded.category, 'withdrawal')
  assert.equal(refunded.type, 'withdrawal.failed_refunded')
  assert.match(refunded.summary, /returned to your balance/)

  // `refundable: false` — wallet/src/withdrawals.ts transitions to **stuck** and holds the
  // funds while an operator establishes whether the payment left. A different fact, not a softer
  // adjective, so it must not share a `type` with the line above.
  const held = failed({ ...base, refundable: false })
  assert.equal(held.type, 'withdrawal.failed_held')
  assert.match(held.summary, /still held/)
  assert.notEqual(held.type, refunded.type)
  assert.notEqual(held.summary, refunded.summary)

  // The field ABSENT must read as held, never as refunded. wallet defaults the same way
  // (`payload['refundable'] === true`, wallet/src/server.ts) because refunding a payment that
  // really landed pays the user twice; a timeline promising a refund wallet did not make would
  // contradict the balance on the same screen.
  const silent = failed(base)
  assert.equal(silent.type, 'withdrawal.failed_held')
  assert.doesNotMatch(silent.summary, /returned to your balance/)
  // And a truthy-but-not-true value is not a refund either.
  assert.equal(failed({ ...base, refundable: 'yes' }).type, 'withdrawal.failed_held')
})

test('a failed withdrawal reaches its owner when settlement names one, and nobody when it does not', () => {
  // settlement/src/withdrawals.ts emits `{ withdrawalId, reason, refundable }` — no user.
  // So today this record has no owner and `classify` makes it internal. Pinned as a FACT rather
  // than left implicit: it is the live gap this classifier reports to micro-settlement, and if
  // settlement adds `userId: row.userId` this assertion is what tells us the gap closed.
  const today = classify(
    delivery({
      topic: 'settlement.outbound.failed',
      key: WITHDRAWAL,
      payload: { withdrawalId: WITHDRAWAL, reason: 'insufficient gas', refundable: true },
    }).envelope,
    true,
  )
  assert.equal(today.userId, null)
  assert.equal(today.visibility, 'internal')
  // Specifically NOT the withdrawal id. That is the misattribution this topic invites: the key is
  // a uuid, so a key reader returns something that looks like an answer.
  assert.notEqual(today.userId, WITHDRAWAL)

  // And the moment settlement puts the user on the payload, the entry lands in that user's feed
  // with no change in this file.
  const repaired = classify(
    delivery({
      topic: 'settlement.outbound.failed',
      key: WITHDRAWAL,
      payload: { withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'insufficient gas', refundable: true },
    }).envelope,
    true,
  )
  assert.equal(repaired.userId, ALICE)
  assert.equal(repaired.visibility, 'user')
  assert.notEqual(repaired.userId, BOB)
})

test('a sweep is an internal treasury movement and lands in no user\'s feed', () => {
  const swept = classify(
    delivery({
      topic: 'settlement.sweep.completed',
      key: SWEEP_SOURCE,
      payload: {
        outboundId: '018f0000-0000-7000-8000-0000000000aa',
        sweepSourceId: SWEEP_SOURCE,
        chain: 'ethereum',
        network: 'mainnet',
        assetCode: 'SHARD',
        amount: '1000000000000000000',
        fee: '21000',
        txHash: '0xabc',
      },
    }).envelope,
    true,
  )
  // `wallet`, with `wallet.reconciliation_completed`: the two records an operator reads together
  // belong under one filter. Not `deposit` — the user's deposit was credited at
  // `wallet.deposit.confirmed` and nothing about their position changes here.
  assert.equal(swept.category, 'wallet')
  assert.equal(swept.type, 'wallet.sweep_completed')
  assert.equal(swept.userId, null)
  assert.equal(swept.visibility, 'internal')
  // Not the sweep source id dressed up as a person, and not the outbound id either.
  assert.notEqual(swept.userId, SWEEP_SOURCE)
  assert.match(swept.summary, /ethereum mainnet/)

  // The amount is a smallest-units integer (settlement/src/withdrawals.ts) and the payload
  // carries no decimals, so it reaches neither the prose NOR the column. A figure eighteen orders
  // of magnitude wrong is worse than no figure.
  //
  // The column half of that reversed with #199: this assertion used to read
  // `assert.equal(swept.amount, '1000000000000000000')`, on the theory that the column was typed
  // storage rather than presentation. `hub-web/src/pages/activity.tsx` renders it through a
  // decimal formatter beside `record.assetCode`, so it was presentation all along.
  assert.equal(swept.amount, null)
  assert.doesNotMatch(swept.summary, /1000000000000000000/)
  // Not lost, though — the classifier declares `amount`, so the producer's own integer survives
  // verbatim in the stored payload, where nothing renders it as money.
  assert.equal(swept.payload['amount'], '1000000000000000000')

  // A user id smuggled onto the payload does not make a treasury movement somebody's news.
  const withUser = classify(
    delivery({
      topic: 'settlement.sweep.completed',
      key: SWEEP_SOURCE,
      payload: { sweepSourceId: SWEEP_SOURCE, userId: ALICE, chain: 'ethereum', network: 'mainnet' },
    }).envelope,
    true,
  )
  assert.equal(withUser.userId, null)
  assert.equal(withUser.visibility, 'internal')
})

/* ------------------------------------------------------------------ wallet's five */

/** A wallet id is a uuid too — the same trap as a session id, a bot id and a withdrawal id. */
const WALLET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab'

test("a deposit address assigned reaches its owner, and a ROTATION does not read as a first assignment", () => {
  // The payload wallet really sends (`wallet/src/deposits.ts`).
  const assigned = classify(
    delivery({
      topic: 'wallet.deposit_address.assigned',
      // Keyed `chain:network:address_key` — not a uuid at all, so `userFromKey` would have
      // returned null and filed 243 of these in nobody's feed rather than crashing.
      key: 'ethereum:mainnet:key-1',
      actor: 'service:wallet',
      payload: {
        assignmentId: '018f0000-0000-7000-8000-0000000000ab',
        userId: ALICE,
        assetCode: 'SHARD',
        chain: 'ethereum',
        network: 'mainnet',
        address: '0x00000000000000000000000000000000000000ab',
        walletId: WALLET,
        scheme: 'hd',
        supersedesId: null,
      },
    }).envelope,
    true,
  )
  assert.equal(assigned.category, 'deposit')
  assert.equal(assigned.type, 'deposit.address_assigned')
  assert.equal(assigned.userId, ALICE)
  assert.equal(assigned.visibility, 'user')
  assert.match(assigned.summary, /assigned to you/)
  assert.match(assigned.summary, /0x00000000000000000000000000000000000000ab/)
  assert.equal(assigned.subjectUrn, 'urn:cloudsforge:wallet:deposit_address:ethereum:mainnet:key-1')

  // The rotation. Reading it as another assignment is how a user keeps depositing to an address
  // that has been superseded.
  const rotated = classify(
    delivery({
      topic: 'wallet.deposit_address.assigned',
      key: 'ethereum:mainnet:key-2',
      payload: {
        userId: ALICE,
        assetCode: 'SHARD',
        chain: 'ethereum',
        network: 'mainnet',
        address: '0x00000000000000000000000000000000000000cd',
        supersedesId: '018f0000-0000-7000-8000-0000000000ab',
      },
    }).envelope,
    true,
  )
  assert.match(rotated.summary, /rotated/)
  assert.doesNotMatch(assigned.summary, /rotated/)

  // The custody key urn is the platform's signing credential and is dropped, not stored for ever.
  const withCustody = classify(
    delivery({
      topic: 'wallet.deposit_address.assigned',
      key: 'ethereum:mainnet:key-3',
      payload: { userId: ALICE, custodyKeyUrn: 'urn:cloudsforge:wallet:custody-key:secret-one' },
    }).envelope,
    true,
  )
  assert.ok(!JSON.stringify(withCustody).includes('secret-one'), 'the custody key urn reached the record')
})

test('an external wallet link verified and revoked are the same wallet\'s story, under one filter', () => {
  const verified = classify(
    delivery({
      topic: 'wallet.link.verified',
      key: WALLET,
      // The actor really is the user here (`wallet/src/links.ts`) — and the owner is still
      // read off the payload, so nothing depends on that staying true.
      actor: `user:${ALICE}`,
      payload: {
        walletId: WALLET,
        userId: ALICE,
        scheme: 'eip191',
        chain: 'ethereum',
        network: 'mainnet',
        address: '0x00000000000000000000000000000000000000ef',
        authorisations: ['withdraw'],
      },
    }).envelope,
    true,
  )
  assert.equal(verified.category, 'wallet')
  assert.equal(verified.type, 'wallet.link_verified')
  assert.equal(verified.userId, ALICE)
  assert.notEqual(verified.userId, WALLET, 'the wallet id is a uuid and is not a person')
  assert.equal(verified.visibility, 'user')
  // The address is the only part a user can actually check against the wallet they hold.
  assert.match(verified.summary, /0x00000000000000000000000000000000000000ef/)
  assert.match(verified.summary, /withdrawal destination/)

  // ── Revocation is two facts, and the actor is not the owner ────────────────────────────────
  const revoked = (payload: Record<string, unknown>, actor: Actor) =>
    classify(delivery({ topic: 'wallet.link.revoked', key: WALLET, payload, actor }).envelope, true)

  // §3.2: `authorisation: null` is the whole disconnect, and it is revoked BY SUPPORT here.
  const disconnected = revoked(
    { walletId: WALLET, userId: ALICE, authorisation: null, remaining: [] },
    'operator:support',
  )
  assert.equal(disconnected.category, 'wallet')
  assert.equal(disconnected.type, 'wallet.link_revoked')
  // The account holder's news, not the support agent's. Reading the actor here would file it in
  // a feed the person it happened to cannot see.
  assert.equal(disconnected.userId, ALICE)
  assert.match(disconnected.summary, /disconnected/)

  // One permission off a link that still stands is a different entry, with a different type.
  const narrowed = revoked(
    { walletId: WALLET, userId: ALICE, authorisation: 'withdraw', remaining: ['receive'] },
    `user:${ALICE}`,
  )
  assert.equal(narrowed.type, 'wallet.authorisation_revoked')
  assert.notEqual(narrowed.type, disconnected.type)
  assert.match(narrowed.summary, /"withdraw"/)
  assert.match(narrowed.summary, /1 permission left/)
  assert.doesNotMatch(narrowed.summary, /disconnected/)

  // A producer that stopped sending the field falls to the MORE serious reading, never the softer
  // one — the same way an unrecognised session revocation reason does.
  assert.equal(revoked({ userId: ALICE }, 'system').type, 'wallet.link_revoked')
})

test("a refunded withdrawal and a stuck one say opposite things about where the money is", () => {
  const refunded = classify(
    delivery({
      topic: 'wallet.withdrawal.refunded',
      key: WITHDRAWAL,
      payload: {
        withdrawalId: WITHDRAWAL,
        userId: ALICE,
        assetCode: 'SHARD',
        amount: '2500000000000000000',
        reason: 'chain_rejected: nonce too low from 0x00000000000000000000000000000000000000ff',
      },
    }).envelope,
    true,
  )
  assert.equal(refunded.category, 'withdrawal')
  assert.equal(refunded.type, 'withdrawal.refunded')
  assert.equal(refunded.userId, ALICE)
  assert.notEqual(refunded.userId, WITHDRAWAL)
  assert.equal(refunded.visibility, 'user')
  assert.match(refunded.summary, /returned to your balance/)

  // wallet's `amount` is smallest units (`wallet/src/withdrawals.ts`) with no decimals on
  // the payload, so neither the prose nor the column prints it. The column assertion was
  // `'2500000000000000000'` until #199; it is null now, because a frontend renders that column as
  // a decimal figure and the record is `user`-visible — this was the raw integer reaching a real
  // person by the one route the prose rule did not cover.
  assert.equal(refunded.amount, null)
  assert.doesNotMatch(refunded.summary, /2500000000000000000/)

  // `reason` is `${err.code}: ${err.message}` and carries a destination address on a chain error.
  // Not declared, so it is dropped at ingest rather than kept for ever in a column erasure of the
  // third party cannot reach.
  assert.deepEqual(Object.keys(refunded.payload).sort(), ['__redacted', 'userId'])
  assert.ok(!JSON.stringify(refunded).includes('0x00000000000000000000000000000000000000ff'))

  // ── The stuck one. The money has NOT come back, and the entry must not read as though it has ──
  const stuck = classify(
    delivery({
      topic: 'wallet.withdrawal.stuck',
      key: WITHDRAWAL,
      actor: 'service:wallet',
      payload: { withdrawalId: WITHDRAWAL, userId: ALICE, stuckMinutes: 60 },
    }).envelope,
    true,
  )
  assert.equal(stuck.category, 'withdrawal')
  assert.equal(stuck.userId, ALICE)
  // Always user-visible, unlike settlement's: `sweepStuck` selects `user_id` off the row, so this
  // topic always names somebody. A balance a user cannot spend and cannot explain is the failure.
  assert.equal(stuck.visibility, 'user')
  assert.match(stuck.summary, /still held/)
  assert.doesNotMatch(stuck.summary, /returned to your balance$/)
  assert.match(stuck.summary, /60 minutes/)

  // THE VERDICT ON THE DUPLICATE NAME. Both `wallet.withdrawal.stuck` and
  // `settlement.withdrawal.stuck` are registered and they are not one fact: settlement's is keyed
  // `chain:network` and means a BROADCAST transaction has not confirmed, wallet's is keyed
  // `withdrawal_id` and means settlement never said anything at all. Distinct types, because the
  // frontend switches on `type` and an operator has to be able to tell them apart.
  assert.equal(stuck.type, 'withdrawal.stuck_no_settlement')
  assert.equal(CLASSIFIERS['settlement.withdrawal.stuck'].type, 'withdrawal.stuck')
  assert.notEqual(stuck.type, CLASSIFIERS['settlement.withdrawal.stuck'].type)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ── SMALLEST UNITS NEVER REACH A PERSON (micro-org#199) ───────────────────────────────────────
 *
 * The defect these close, in the words a user read it in:
 *
 *   > "Deposit of 2500000000000000000 SHARD confirmed and credited."
 *
 * Three summaries printed `payload.amount` as though it were a decimal figure, and the `amount`
 * COLUMN took the same value for every money topic in the estate — where
 * `hub-web/src/pages/activity.tsx,202` renders it through a decimal formatter beside
 * `record.assetCode`. Both routes are covered here, because fixing only the prose would have
 * moved the wrong number one column to the right and called it typed.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

/** 2.5 SHARD, in the units wallet, settlement, ledger and market all put on the wire. */
const SMALLEST_UNITS = '2500000000000000000'

/**
 * The producers whose `amount` is an integer count of indivisible units.
 *
 * **Written out here rather than imported from `classify.ts`.** Two copies that must agree is the
 * point: a test that imported the service's own set could only prove the code equals itself, and
 * would pass on the day somebody quietly dropped `wallet` from it. The evidence for each is in
 * `money`'s header in `classify.ts`, and each entry is a schema or an emit-site citation.
 */
const SMALLEST_UNIT_PRODUCERS = new Set(['wallet', 'settlement', 'ledger', 'market'])

test('THE RULE: a smallest-units figure reaches neither a summary nor the amount column, on any topic', () => {
  // Driven over every registered topic of the four producers rather than over the three named in
  // the issue, because "the three that predate the precedent" is a description of how the defect
  // was found and not of where it can occur. A wallet topic registered tomorrow is covered on the
  // day it lands, which is the same reason `classify` keys the rule on the producer.
  //
  // `drift` is deliberately absent from the payload: `ledger.reconciliation.completed` is the
  // file's one documented exception (internal, no user, no asset code, nothing emits it), and a
  // fixture that fed it would be asserting against a rule this repository does not claim.
  let checked = 0
  for (const topic of TOPIC_NAMES) {
    if (!SMALLEST_UNIT_PRODUCERS.has(TOPICS[topic].producer)) continue
    const classified = classify(
      delivery({
        topic,
        key: ALICE,
        // Every spelling of "who this is about" the four producers use, so the record resolves to
        // a user and the classifier takes its user-visible branch rather than an anonymous one.
        payload: {
          userId: ALICE,
          sellerSubject: `user:${ALICE}`,
          ownerSubject: `user:${ALICE}`,
          amount: SMALLEST_UNITS,
          price: SMALLEST_UNITS,
          assetCode: 'SHARD',
        },
      }).envelope,
      true,
    )
    assert.doesNotMatch(
      classified.summary,
      new RegExp(SMALLEST_UNITS),
      `${topic} prints a smallest-units integer in a summary a user reads`,
    )
    assert.equal(
      classified.amount,
      null,
      `${topic} files a smallest-units integer under the column hub-web renders as a decimal`,
    )
    checked += 1
  }
  assert.ok(checked >= 15, `only ${checked} money topics were checked`)
})

test('a deposit prints the figure wallet converted, and never the one it did not', () => {
  // The pair as `wallet/src/deposits.ts` emits it. wallet is the only party that can do
  // this conversion — it needs `chainSpec(assetCode).decimals`, and a classifier may not read a
  // database to find one — so where the pair is on the payload it is authoritative.
  const credited = classify(
    delivery({
      topic: 'wallet.deposit.confirmed',
      key: 'wallet-1',
      payload: { userId: ALICE, amount: SMALLEST_UNITS, amountFormatted: '2.5', assetCode: 'SHARD' },
    }).envelope,
    true,
  )
  assert.equal(credited.summary, 'Deposit of 2.5 SHARD confirmed and credited.')
  assert.equal(credited.amount, '2.5')
  // The sentence a user actually read before #199, asserted as a string so the regression cannot
  // come back through a reworded summary.
  assert.notEqual(credited.summary, `Deposit of ${SMALLEST_UNITS} SHARD confirmed and credited.`)

  // Both halves survive the allowlist: the decimal one is what a person reads, and the raw one is
  // wallet's own figure, kept in its own units in a JSON document nothing renders as money.
  assert.equal(credited.payload['amountFormatted'], '2.5')
  assert.equal(credited.payload['amount'], SMALLEST_UNITS)

  // A deposit whose producer sent no formatted figure still names the asset. The old fallback was
  // "A deposit was confirmed.", which threw away a fact that was on the payload and is not a scale
  // question — the code is knowable here and only the number is not.
  const bare = classify(
    delivery({
      topic: 'wallet.deposit.confirmed',
      key: 'wallet-1',
      payload: { userId: ALICE, amount: SMALLEST_UNITS, assetCode: 'SHARD' },
    }).envelope,
    true,
  )
  assert.equal(bare.summary, 'A SHARD deposit was confirmed and credited.')
  assert.equal(bare.amount, null)
})

test('a withdrawal requested and one completed name the asset and decline the figure', () => {
  // `WithdrawalRequestedPayload` (`wallet/src/withdrawals.ts`) sends `amount`, `fee` and
  // `net` raw and nothing formatted — twenty lines below `toWithdrawal`, which converts the same
  // row for wallet's own API response. So this is an omission in micro-wallet, and the day it is
  // repaired `money` picks the formatted field up and this summary starts printing the figure with
  // no change in this file. Until then the sentence declines it rather than guessing at eighteen.
  const requested = classify(
    delivery({
      topic: 'wallet.withdrawal.requested',
      key: 'wallet-1',
      payload: { userId: ALICE, amount: SMALLEST_UNITS, fee: '1000', net: '2499999999999999000', assetCode: 'SHARD' },
    }).envelope,
    true,
  )
  assert.equal(requested.summary, 'A SHARD withdrawal was requested.')
  assert.equal(requested.amount, null)
  assert.notEqual(requested.summary, `Withdrawal of ${SMALLEST_UNITS} SHARD requested.`)

  // Settlement's side of the same money. `base(row)` puts `row.amount.toString()` on the payload
  // (`settlement/src/withdrawals.ts`) and settlement's own parser calls that field "a
  // decimal string of smallest units" (`withdrawals.ts`), so it is the same scale again.
  // The hash stays: it is the fact a user can check against a block explorer, and it is not money.
  const completed = classify(
    delivery({
      topic: 'settlement.withdrawal.completed',
      key: WITHDRAWAL,
      payload: {
        withdrawalId: WITHDRAWAL,
        userId: ALICE,
        amount: SMALLEST_UNITS,
        assetCode: 'SHARD',
        transactionHash: '0xabc',
      },
    }).envelope,
    true,
  )
  assert.equal(completed.summary, 'Your SHARD withdrawal was sent in 0xabc.')
  assert.equal(completed.amount, null)
  assert.notEqual(completed.summary, `${SMALLEST_UNITS} SHARD was sent in 0xabc.`)

  // Both are the user's own news, not internal — the repair removes a figure and nothing else.
  for (const record of [requested, completed]) {
    assert.equal(record.userId, ALICE)
    assert.equal(record.visibility, 'user')
    assert.equal(record.assetCode, 'SHARD')
  }
})

/* ------------------------------------------------------------------ the retired asset */

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * ── THE SENTENCE THAT NAMED A WOUND-DOWN ASSET, AND THE THREE TESTS THAT REPLACE IT ──────────
 *
 * Both reward rules ended `` `You earned ${amount} Shards.` `` — the unit typed into `classify.ts`
 * rather than read off anything — so a player who finished a season read "You earned 250 Shards."
 * in their feed. SHARD is RETIRED (`RETIRED_ASSETS`, `contracts/packages/chain/src/index.ts:58`)
 * and nothing may be newly denominated in it. micro-org #227 is the estate sweep; this repository
 * is one row of seven.
 *
 * **No test pinned that string, which is its own finding.** micro-notify's did — `catalogue.test.ts`
 * asserted `params['rewardName'] === '250 Shards'` under the name "names the Shards", so its suite
 * was green BECAUSE of the defect and any correction to the copy turned it red. Nothing here was
 * locked in the same way; these two summaries were simply never asserted at all, by 92 tests that
 * covered every neighbouring rule. An unasserted user-visible sentence is the cheaper version of
 * the same failure, and it is what the three tests below close:
 *
 *   1. with no asset code on the event — which is every real event today — no unit is rendered and
 *      BOTH rules render the same sentence, because they now share `seasonRewardSummary`;
 *   2. with an asset code on the event, the code rendered is the one the payload named, so the
 *      unit is derived and not chosen here;
 *   3. no summary this build can produce names a retired asset — asserted against `RETIRED_ASSETS`
 *      itself rather than against the word "Shards", so it extends itself the next time an asset
 *      is wound down, and driven over every registered topic rather than over these two.
 *
 * The payloads are the producers' real ones, read at the emit sites: `worlds/src/rewards.ts:555-574`
 * and `emberkin/src/seasons.ts:136-142`. Neither carries an asset code. Both services nevertheless
 * credit the player in SHARD (`rewardPostings`, `worlds/src/ledgerclient.ts:155-183` and
 * `emberkin/src/ledgerclient.ts:116-141`), which is why "EMBER" would have been a worse fix than
 * the defect: a unit this service invented on behalf of the one that moved the money.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */
const REWARD_EVENTS = [
  {
    topic: 'worlds.reward.granted' as TopicName,
    // Keyed by reward id (`worlds/src/rewards.ts` — `key: granted.id`), so the user has to come
    // off the payload; asserted below, because a reward in nobody's feed is the other way this
    // pair has failed before.
    key: 'grant-7',
    payload: {
      rewardId: 'grant-7',
      seasonId: 'season-1',
      titleId: 'title-3',
      userId: ALICE,
      reason: 'objective:first-build',
      amountShards: '250',
      journalEntryId: 'j-9',
      budgetRemainingShards: '9750',
    } as Record<string, unknown>,
  },
  {
    topic: 'emberkin.reward.granted' as TopicName,
    // Keyed by the idempotency key (`emberkin/src/seasons.ts` — `key`), which is not a uuid.
    key: `season-1:${ALICE}:pass`,
    payload: {
      seasonId: 'season-1',
      userId: ALICE,
      reason: 'season placement',
      amount: '250',
      journalEntryId: 'j-9',
    } as Record<string, unknown>,
  },
] as const

test('a season reward whose event names no asset names no unit, in both rules', () => {
  const summaries: string[] = []
  for (const each of REWARD_EVENTS) {
    const classified = classify(
      delivery({ topic: each.topic, key: each.key, payload: each.payload }).envelope,
      true,
    )
    assert.equal(classified.category, 'reward', each.topic)
    assert.equal(classified.userId, ALICE, each.topic)
    assert.equal(classified.visibility, 'user', each.topic)
    // The sentence a player actually read, asserted as a string so the regression cannot come
    // back through a reworded summary — the shape `wallet.deposit.confirmed` uses one section up.
    assert.notEqual(classified.summary, 'You earned 250 Shards.', each.topic)
    // Not "You earned 250." either. A quantity whose unit the reader supplies is the shape this
    // file calls a plausible screen over nothing, and `money`'s header refuses it for scale for
    // exactly the same reason. The figure is not lost: both rules declare their amount field, so
    // the producer's own number is in `activity_records.payload` in its own units.
    assert.doesNotMatch(classified.summary, /250/, each.topic)
    summaries.push(classified.summary)
  }
  // One function, so one sentence. The two rules disagreeing — emberkin appending a unit, worlds
  // appending none, in micro-notify's copy of this same pair — is half of what #227 reports.
  assert.deepEqual(summaries, ['You earned a season reward.', 'You earned a season reward.'])
})

test('a season reward whose event DOES name an asset renders that code, derived', () => {
  // Dead against both of today's payloads and written anyway: this is the branch that makes the
  // repair outlive the re-denomination in micro-org #226. The day either producer puts `assetCode`
  // on its event both summaries begin naming it with no edit to `classify.ts`, which is the whole
  // point of never having typed a unit into it. EMBER appears below only because the payload says
  // EMBER — change the payload and this assertion has to change with it, which is the difference
  // between a derived unit and a second hard-coded one. BTC is the second half of that proof.
  for (const each of REWARD_EVENTS) {
    for (const [code, expected] of [
      ['EMBER', 'You earned 250 EMBER.'],
      ['BTC', 'You earned 250 BTC.'],
    ] as const) {
      const classified = classify(
        delivery({
          topic: each.topic,
          key: each.key,
          payload: { ...each.payload, assetCode: code },
        }).envelope,
        true,
      )
      assert.equal(classified.summary, expected, `${each.topic} with ${code}`)
      // And the code reaches the record's own column, from the same payload field.
      assert.equal(classified.assetCode, code, each.topic)
    }
  }
})

test('THE RULE: no summary names a retired asset the payload did not', () => {
  // Bound to the estate's LIST rather than to the word "Shards": the list is the thing being
  // defended, and an assertion naming SHARD would need editing on the day EMBER is wound down —
  // exactly the day it would need to still work. Matched case-insensitively because the defect
  // was spelled "Shards" and not "SHARD", and a case-sensitive check on the asset code would have
  // walked straight past it.
  assert.ok(RETIRED_ASSETS.length > 0, 'no retired assets — this test would pass vacuously')
  const retired = RETIRED_ASSETS.map((code) => new RegExp(code, 'i'))

  // Driven over every registered topic, not over the two in the issue. "The two the sweep found"
  // describes how the defect was found and not where it can occur, and the next one will be
  // written by somebody who has never read #227. The payload deliberately carries NO asset code:
  // a summary that names a code the producer sent is not this rule's business — `A SHARD deposit
  // was confirmed and credited.` is CORRECT above, because a deposit is a past fact that really
  // was denominated that way. What is refused here is a code this repository supplied itself.
  let checked = 0
  for (const topic of TOPIC_NAMES) {
    const classified = classify(
      delivery({
        topic,
        key: ALICE,
        payload: {
          userId: ALICE,
          subject: ALICE,
          sellerSubject: `user:${ALICE}`,
          ownerSubject: `user:${ALICE}`,
          amount: '250',
          amountShards: '250',
          price: '250',
        },
      }).envelope,
      true,
    )
    for (const pattern of retired) {
      assert.doesNotMatch(classified.summary, pattern, `${topic} names a retired asset unprompted`)
    }
    checked += 1
  }
  assert.equal(checked, TOPIC_NAMES.length)

  // …and the two reward rules refuse a retired code even when the producer DOES send one, which
  // is a judgement rather than a consequence. A reward is news about something a player has just
  // been given, in an asset the estate is winding down — not a description of a past movement, the
  // way `wallet.deposit.confirmed` and `mint-web/src/lib/format.ts`'s "2,500 SHARD" are. The same
  // call micro-notify made in `rewardNameOf` for the same two topics.
  for (const each of REWARD_EVENTS) {
    for (const code of RETIRED_ASSETS) {
      const classified = classify(
        delivery({
          topic: each.topic,
          key: each.key,
          payload: { ...each.payload, assetCode: code },
        }).envelope,
        true,
      )
      assert.equal(classified.summary, 'You earned a season reward.', `${each.topic} with ${code}`)
    }
  }
})

/* ------------------------------------------------------------------ delivery parsing */

test('a well-formed delivery parses through the contract, not around it', () => {
  const { body } = delivery({ topic: 'identity.session.created', key: ALICE, payload: { device: 'Firefox' } })
  const parsed = parseDelivery(body)
  assert.equal(parsed.known, true)
  assert.equal(parsed.envelope.topic, 'identity.session.created')
})

test('an unregistered topic parses as unknown rather than being refused', () => {
  const { body } = unknownTopicDelivery()
  const parsed = parseDelivery(body)
  assert.equal(parsed.known, false)
  assert.equal(parsed.envelope.topic, 'worlds.session.ended')
})

test('an unregistered topic still needs the fields a quarantine row is made of', () => {
  const envelope = { topic: 'worlds.session.ended', id: 'not-a-uuid', key: '', payload: {} }
  assert.throws(() => parseDelivery(JSON.stringify(envelope)), MalformedEventError)
})

test('THE RULE: quarantine forgives an unregistered TOPIC and nothing else about the envelope', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The defect this file is closing, and it was activity's own.
  //
  // Quarantine used to run a SHORTER checklist for an unregistered topic — id, key, occurredAt,
  // producer, correlationId, payload — which omitted `actor` and `version`. So an unregistered
  // topic got a free pass on envelope correctness, silently: the row landed as `unclassified` and
  // looked exactly like a consumer that is merely behind its producers.
  //
  // `devplatform` shipped two illegal actors under that shelter — `key:<display>` for an API-key
  // caller and `system:identity` on the organisation-erasure path — and NOTHING in the estate said
  // so, because `devplatform.key.revoked` was unregistered here. The day contracts registered it,
  // every one of those envelopes would have started being refused: four topics breaking at once on
  // a commit that touched no producer. Each case below is an envelope that used to be stored.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const illegal: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    // devplatform/src/server.ts spelled this `key:${display}` until it was fixed. `key` is not
    // an ActorKind — the four are user, service, operator, system.
    ['an API-key caller spelled `key:`', { actor: 'key:cfk_live_abcd1234' }, /actor/],
    // The erasure path passed `system:identity`. `system` is the one kind that takes NO subject,
    // so parseActor matches the bare word and then refuses `system:` as an unknown kind.
    ['the erasure path spelled `system:`', { actor: 'system:identity' }, /actor/],
    // An interpolation whose value was undefined types as a valid Actor and is only a runtime fault.
    ['an actor with no subject', { actor: 'user:' }, /actor/],
    ['no actor at all', { actor: undefined }, /actor/],
    // The integer-version defect that hit four services at once, arriving on an unregistered topic.
    ['a version stamped as an integer', { version: 1 }, /version/],
    ['no version at all', { version: undefined }, /version/],
  ]

  for (const [name, overrides, expected] of illegal) {
    const { body } = unknownTopicDelivery('worlds.session.ended', { userId: ALICE }, overrides)
    assert.throws(
      () => parseDelivery(body),
      (err: unknown) => {
        assert.ok(err instanceof MalformedEventError, `${name} was accepted rather than refused`)
        assert.ok(
          err.errors.some((each) => expected.test(each)),
          `${name} was refused, but for the wrong reason: ${err.errors.join('; ')}`,
        )
        return true
      },
      name,
    )
  }

  // And the one fact quarantine DOES forgive still gets through, with every other field intact.
  // Without this the rule above could be satisfied by refusing everything, which would drop the
  // events this service exists to keep.
  const clean = parseDelivery(unknownTopicDelivery().body)
  assert.equal(clean.known, false)
  assert.equal(clean.envelope.topic, 'worlds.session.ended')

  // A malformed envelope on an unregistered topic reports its real defects and NOT the missing
  // registration: being behind a producer is never the caller's fault, and naming it would send a
  // producer to go and fix a release it does not own.
  const both = unknownTopicDelivery('worlds.session.ended', { userId: ALICE }, { actor: 'key:x' })
  assert.throws(() => parseDelivery(both.body), (err: unknown) => {
    assert.ok(err instanceof MalformedEventError)
    assert.equal(err.errors.some((each) => /not in this registry/.test(each)), false, err.errors.join('; '))
    return true
  })
})

test('a malformed body is a validation failure, never a thrown SyntaxError', () => {
  assert.throws(() => parseDelivery('{not json'), MalformedEventError)
  assert.throws(() => parseDelivery('[]'), MalformedEventError)
  // A registered topic with a producer that does not own it: the topic namespace is the ownership
  // boundary, and contracts-events refuses it for us.
  const forged = JSON.stringify({
    ...makeEvent({ topic: 'ledger.entry.posted', key: 'a-1', actor: 'system', payload: {} }),
    producer: 'market',
  })
  assert.throws(() => parseDelivery(forged), MalformedEventError)
})

/* ------------------------------------------------------------------ signing */

test('a signature is over the exact bytes, and one byte of tampering breaks it', () => {
  const envelope = makeEvent({ topic: 'ledger.entry.posted', key: 'a-1', actor: 'system', payload: { amount: '1' } })
  const body = serialiseEvent(envelope)
  const signature = signDelivery(body, SECRET)
  assert.equal(verifyDelivery(body, signature, [SECRET]).ok, true)
  assert.equal(verifyDelivery(`${body} `, signature, [SECRET]).ok, false)
  const tampered = body.replace('"amount":"1"', '"amount":"9"')
  assert.equal(verifyDelivery(tampered, signature, [SECRET]).ok, false)
})

/* ------------------------------------------------------------------ cursors */

test('a cursor round-trips, and a forged one is refused rather than misread', () => {
  const at = new Date('2026-07-30T12:00:00.000Z')
  const cursor = encodeCursor({ occurredAt: at, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  const decoded = decodeCursor(cursor)
  assert.equal(decoded.occurredAt.toISOString(), at.toISOString())
  assert.equal(decoded.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

  assert.throws(() => decodeCursor('bm90LWEtY3Vyc29y'), BadCursorError)
  assert.throws(() => decodeCursor('!!!'), BadCursorError)
})

/* ------------------------------------------------------------------ the payload allowlist */

/**
 * The keys `classify` reads for EVERY topic, on its own account rather than a classifier's.
 *
 * They are exempt from the "declared or not read" half of the rule below and not from the other
 * half: a topic may decline to declare them, and a topic that declares them is stating that this
 * is a payload which really carries them. `identity.user.registered` declaring `price` would fail.
 *
 * `amountFormatted` and `priceFormatted` joined them with `money` (`classify.ts`): the `amount`
 * column is filled from the producer's own decimal figure where there is one, so both spellings
 * are probed on every topic. `wallet.deposit.confirmed` declares `amountFormatted` because wallet
 * genuinely sends it (`wallet/src/deposits.ts`), which is exactly what a declaration means.
 */
const GENERIC_KEYS = new Set(['amount', 'amountFormatted', 'price', 'priceFormatted', 'assetCode'])

/** Every payload key a classifier touches, recorded by handing it a payload that watches. */
function keysReadBy(topic: TopicName): Set<string> {
  const read = new Set<string>()
  const { envelope } = delivery({ topic, key: ALICE, payload: {} })
  const watched = {
    ...envelope,
    payload: new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key === 'string') read.add(key)
          return undefined
        },
        // `payloadOf` type-tests the payload and `Object.keys` is never called on it, but a Proxy
        // that lied about its shape would make this whole test measure the Proxy.
        ownKeys: () => [],
      },
    ),
  }
  classify(watched, true)
  return read
}

test('THE RULE: a classifier may not read a payload key it has not declared', () => {
  // The regression this makes impossible is the one that has no diff: a producer adds a field, the
  // classifier starts reading it, and it is stored for ever because nobody updated a list. Driven
  // against a recording Proxy rather than against a hand-written table, so it covers a topic
  // registered tomorrow on the day it lands.
  //
  // It fails in BOTH directions, and the second is the one that protects other people's data:
  // an over-declared key is a value kept for no reason, and a second party's identifier left in a
  // payload is one that party's own erasure can never reach (`records.ts`, `eraseUser`).
  let checked = 0
  for (const topic of TOPIC_NAMES) {
    const declared = new Set<string>(CLASSIFIERS[topic].payloadKeys)
    const read = keysReadBy(topic)

    for (const key of read) {
      if (GENERIC_KEYS.has(key)) continue
      assert.ok(declared.has(key), `${topic} reads payload.${key} and does not declare it`)
    }
    for (const key of declared) {
      assert.ok(read.has(key), `${topic} declares payload.${key} and never reads it`)
    }
    checked += 1
  }
  assert.equal(checked, TOPIC_NAMES.length)
  assert.ok(checked > 50, `only ${checked} topics were checked`)
})

test('THE RULE: an undeclared payload key is dropped at ingest, not stored and cleaned up later', () => {
  // `identity.email.verification_requested` is the live case and the reason this exists: its real
  // payload (`identity/src/emailVerification.ts`) carries a direct identifier and a
  // single-use credential, and this service needs neither. Under the old code both were written
  // verbatim into a column nothing ever deleted.
  const { envelope } = delivery({
    topic: 'identity.email.verification_requested',
    key: ALICE,
    payload: {
      userId: ALICE,
      handle: 'a-real-handle',
      email: 'someone@example.test',
      expiresAt: '2026-08-06T11:00:00.000Z',
      linkable: true,
      verifyUrl: 'https://hub.cloudsforge.online/verify?token=a-live-single-use-credential',
    },
  })
  const classified = classify(envelope, true)

  // The one declared key, and nothing else.
  assert.deepEqual(Object.keys(classified.payload).sort(), ['__redacted', 'linkable'])
  assert.equal(classified.payload['linkable'], true)

  // Neither the address nor the credential survives anywhere on the record — not in the payload,
  // and not smuggled into the summary a user's feed renders.
  const stored = JSON.stringify(classified)
  assert.ok(!stored.includes('someone@example.test'), 'the email address reached the record')
  assert.ok(!stored.includes('a-live-single-use-credential'), 'the credential reached the record')
  assert.ok(!stored.includes('a-real-handle'), 'the handle reached the record')

  // The drop is VISIBLE. Key names are schema, not personal data, and a producer that starts
  // sending a new field has to show up somewhere or this is the same silence in a nicer shape.
  assert.deepEqual(classified.payload['__redacted'], ['email', 'expiresAt', 'handle', 'userId', 'verifyUrl'])
  assert.deepEqual([...classified.redactedKeys].sort(), ['email', 'expiresAt', 'handle', 'userId', 'verifyUrl'])
})

test('a declared key is still bounded: a long string is capped and a nested document is reduced', () => {
  // A key allowlist says which keys, and nothing at all about what a value holds. Without this,
  // declaring one key would be a way to declare everything hanging off it.
  const { envelope } = delivery({
    topic: 'devplatform.key.revoked',
    key: '99999999-9999-4999-8999-999999999999',
    payload: {
      display: 'x'.repeat(4_000),
      // `INTERNAL-4821` is the value that tightened `ASSET_CODE` in `redact.ts`: an upper-case
      // alphanumeric token with a separator is also the shape of a document or passport reference,
      // and the first version of that pattern stored it verbatim.
      reason: { note: 'a free-text explanation that nobody reviewed', ticket: 'INTERNAL-4821' },
    },
  })
  const classified = classify(envelope, true)

  const display = classified.payload['display']
  assert.equal(typeof display, 'string')
  assert.ok((display as string).length <= 512, `a declared string was stored at ${(display as string).length}`)

  // The nested object keeps its keys and loses its prose, exactly as a quarantined payload does.
  assert.deepEqual(classified.payload['reason'], { note: '<string:44>', ticket: '<string:13>' })
})

/* ------------------------------------------------------------------ the quarantine payload */

test('THE RULE: an unknown topic keeps its shape and its identifiers, and loses its prose', () => {
  // The quarantine is the dangerous path: there is no declaration to check against, by definition.
  // Dropping the payload would destroy the reclassification the quarantine exists for; keeping it
  // verbatim is the defect. So structure and identifiers survive and free text does not.
  const { envelope } = unknownTopicDelivery('worlds.session.ended', {
    userId: ALICE,
    ownerSubject: `user:${BOB}`,
    reference: 'urn:cloudsforge:worlds:session:abc-1',
    amount: '12.5',
    assetCode: 'EMBER',
    txHash: '0xdeadbeef',
    startedAt: '2026-08-05T09:00:00.000Z',
    seats: 4,
    ranked: true,
    absent: null,
    // The three the issue names, and the three that must not survive.
    email: 'player@example.test',
    postalAddress: '12 Wharf Road, London N1 7GR',
    documentRef: 'passport GBR 123456789',
    // A handle is refused for the same reason a given name is: by SHAPE it is an enum token.
    handle: 'savvaniss',
    nested: { note: 'free text at depth', playerId: BOB },
  })
  const classified = classify(envelope, false)
  const payload = classified.payload

  // Identifiers, timestamps, numbers, decimals, asset codes and hashes: kept.
  assert.equal(payload['userId'], ALICE)
  assert.equal(payload['ownerSubject'], `user:${BOB}`)
  assert.equal(payload['reference'], 'urn:cloudsforge:worlds:session:abc-1')
  assert.equal(payload['amount'], '12.5')
  assert.equal(payload['assetCode'], 'EMBER')
  assert.equal(payload['txHash'], '0xdeadbeef')
  assert.equal(payload['startedAt'], '2026-08-05T09:00:00.000Z')
  assert.equal(payload['seats'], 4)
  assert.equal(payload['ranked'], true)
  assert.equal(payload['absent'], null)

  // Free text: the KEY survives, so a reclassifier knows the field is there. The value does not.
  assert.equal(payload['email'], '<string:19>')
  assert.equal(payload['postalAddress'], '<string:28>')
  assert.equal(payload['documentRef'], '<string:22>')
  assert.equal(payload['handle'], '<string:9>')
  assert.deepEqual(payload['nested'], { note: '<string:18>', playerId: BOB })

  // Nothing was reported as dropped, because on this path nothing was: an unknown topic has no key
  // this build is entitled to call unexpected.
  assert.deepEqual(classified.redactedKeys, [])

  const stored = JSON.stringify(payload)
  for (const secret of ['player@example.test', 'Wharf Road', 'passport', 'savvaniss', 'free text']) {
    assert.ok(!stored.includes(secret), `${secret} survived the quarantine reduction`)
  }
})

test('the quarantine keeps identifiers on purpose, because erasure has to find them', () => {
  // A uuid is personal data, so keeping it needs its own justification: it is the only thing that
  // lets `eraseUser` reach a quarantined row nobody ever attributed to a user. Dropping it would
  // leave the rest of the row behind with no way to find it — moving the defect, not closing it.
  const { envelope } = unknownTopicDelivery('worlds.session.ended', { player: ALICE })
  const classified = classify(envelope, false)
  assert.equal(classified.userId, null, 'an unknown payload is never guessed at for an owner')
  assert.ok(JSON.stringify(classified.payload).includes(ALICE), 'erasure would have nothing to match')
})
