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
    payload: { userId: ALICE, amount: '25.5', assetCode: 'SHARD' },
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
  // notification for every reason except `signed_out` (notify/src/catalogue.ts:258); a timeline
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

  // A reason this build has never seen — the refresh-family burn at identity/src/server.ts:892 has
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
  // Keyed by WALLET id, so the user comes off the payload — wallet/src/wallets.ts:219.
  assert.equal(custodial.userId, ALICE)
  assert.match(custodial.summary, /created for you/)
  assert.match(custodial.summary, /ethereum mainnet/)

  const external = created({ walletId: 'w-2', userId: ALICE, origin: 'external', chain: 'ethereum', network: 'mainnet' })
  assert.match(external.summary, /linked to your account/)
  assert.notEqual(external.summary, custodial.summary)
})

test('a proposal opening belongs to no one, and a vote belongs to its voter', () => {
  const proposal = '55555555-5555-4555-8555-555555555555'

  // No user anywhere on the emit (community/src/jobs.ts:220-227 — actor `service:community`,
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

  // The payload trade really sends: `{ botId }` and nothing else (trade/src/bots.ts:614).
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

  // 2. An actor that is not a person. `bots.ts:614` writes the OWNER's id off the row rather than
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
        // devplatform/src/apikeys.ts:283-296 — the display and the scopes, never the secret.
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

  // A key minting a key authenticates as `service:<display>` (devplatform/src/server.ts:701). No
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
        // devplatform/src/apikeys.ts:368-382.
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

  // devplatform/src/server.ts:999 — the owner's own DELETE. A receipt.
  const mine = revoked(`user:${ALICE}`, 'rotating')
  assert.equal(mine.category, 'api')
  assert.equal(mine.type, 'api.key_revoked')
  assert.equal(mine.userId, ALICE)
  assert.equal(mine.visibility, 'user')
  assert.match(mine.summary, /Reason given: rotating/)
  assert.doesNotMatch(mine.summary, /by CloudsForge/)

  // devplatform/src/server.ts:1575 — the identity.organisation.deleted handler revokes EVERY live
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
  // `confirmedEvents` (settlement/src/withdrawals.ts:436-462) returns BOTH topics from one
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

  // `refundable: true` — wallet/src/withdrawals.ts:596-600 transitions to `failed` and refunds.
  const refunded = failed({ ...base, refundable: true })
  assert.equal(refunded.category, 'withdrawal')
  assert.equal(refunded.type, 'withdrawal.failed_refunded')
  assert.match(refunded.summary, /returned to your balance/)

  // `refundable: false` — wallet/src/withdrawals.ts:592-594 transitions to **stuck** and holds the
  // funds while an operator establishes whether the payment left. A different fact, not a softer
  // adjective, so it must not share a `type` with the line above.
  const held = failed({ ...base, refundable: false })
  assert.equal(held.type, 'withdrawal.failed_held')
  assert.match(held.summary, /still held/)
  assert.notEqual(held.type, refunded.type)
  assert.notEqual(held.summary, refunded.summary)

  // The field ABSENT must read as held, never as refunded. wallet defaults the same way
  // (`payload['refundable'] === true`, wallet/src/server.ts:873) because refunding a payment that
  // really landed pays the user twice; a timeline promising a refund wallet did not make would
  // contradict the balance on the same screen.
  const silent = failed(base)
  assert.equal(silent.type, 'withdrawal.failed_held')
  assert.doesNotMatch(silent.summary, /returned to your balance/)
  // And a truthy-but-not-true value is not a refund either.
  assert.equal(failed({ ...base, refundable: 'yes' }).type, 'withdrawal.failed_held')
})

test('a failed withdrawal reaches its owner when settlement names one, and nobody when it does not', () => {
  // settlement/src/withdrawals.ts:475-486 emits `{ withdrawalId, reason, refundable }` — no user.
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

  // The amount is a smallest-units integer (settlement/src/withdrawals.ts:123) and the payload
  // carries no decimals, so it stays in its typed column and out of the prose. A figure eighteen
  // orders of magnitude wrong is worse than no figure.
  assert.equal(swept.amount, '1000000000000000000')
  assert.doesNotMatch(swept.summary, /1000000000000000000/)

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
    // devplatform/src/server.ts:701 spelled this `key:${display}` until it was fixed. `key` is not
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
