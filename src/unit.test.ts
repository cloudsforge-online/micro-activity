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
import { TOPICS, TOPIC_NAMES, makeEvent, serialiseEvent, signDelivery, verifyDelivery } from '@cloudsforge/contracts-events'
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
