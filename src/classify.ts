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
  parseTopicName,
  type EventEnvelope,
  type ProducerService,
  type TopicName,
} from '@cloudsforge/contracts-events'
import { UNCLASSIFIED, type Category, type StoredCategory, type Visibility } from './categories.ts'

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
}

interface TopicClassifier {
  readonly category: Category
  readonly type: string
  readonly visibility: Visibility
  readonly userId: (envelope: EventEnvelope) => string | null
  readonly summary: (envelope: EventEnvelope) => string
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
 * The key is a `user:<id>` subject, as `billing.entitlement.granted` uses.
 *
 * An entitlement's subject can also be an organisation, in which case there is no single user and
 * the record is internal until organisation feeds exist. Guessing an owner would put another
 * member's purchase in someone's personal feed.
 */
function userFromSubjectKey(envelope: EventEnvelope): string | null {
  const key = envelope.key
  if (!key.startsWith('user:')) return null
  const id = key.slice('user:'.length)
  return UUID_PATTERN.test(id) ? id : null
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
    category: 'account',
    type: 'account.registered',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'Your account was created.',
  },
  'identity.user.deleted': {
    category: 'account',
    type: 'account.deleted',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'Your account was deleted and your data erased.',
  },
  'identity.session.created': {
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
  'identity.device.added': {
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
    category: 'security',
    type: 'security.mfa_removed',
    visibility: 'user',
    userId: userFromKey,
    summary: (event) =>
      payloadOf(event)['wasLast'] === true
        ? 'Your last two-factor method was removed. Your account is no longer protected by a second factor.'
        : 'A two-factor method was removed.',
  },
  'ledger.entry.posted': {
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
  'ledger.reconciliation.completed': {
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
  'wallet.deposit.confirmed': {
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
    category: 'withdrawal',
    type: 'withdrawal.stuck',
    // Keyed by `chain:network`, so there may be no user on it. When the payload names one the
    // record is theirs; otherwise it is an operational record that pages somebody.
    visibility: 'user',
    userId: userFromPayload,
    summary: () => 'A withdrawal has not confirmed within its deadline and is being investigated.',
  },
  /* ── aetherholm — the third Worlds title, and the first game in the registry ────────────────
   *
   * The sixteen categories predate any game: 01-product-vision promises "every account, money,
   * asset, GAME and governance event on one timeline", and there is no `game` category to put one
   * in. These five map to the nearest honest homes — founding and provisioning are `ownership`,
   * completions are `reward`, a season opening is `community` and internal. Adding the missing
   * category is a schema CHECK change and is recorded as a gap rather than smuggled in here.
   */
  'aetherholm.season.opened': {
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
    category: 'reward',
    type: 'aetherholm.research_completed',
    visibility: 'user',
    userId: userFromPayload,
    summary: () => 'Research completed.',
  },
  'aetherholm.skerry.provisioned': {
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
    category: 'security',
    type: 'security.key_export_requested',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'A private key export was requested. It will not complete for 24 hours.',
  },
  'custody.key.exported': {
    category: 'security',
    type: 'security.key_exported',
    visibility: 'user',
    userId: userFromKey,
    summary: () => 'A private key left the platform. That wallet is now self-custodied.',
  },
  'mint.deploy.confirmed': {
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
  'community.proposal.executed': {
    category: 'governance',
    type: 'governance.proposal_executed',
    visibility: 'user',
    userId: userFromPayload,
    summary: (event) => {
      const title = text(event, 'title', 64)
      return title ? `Proposal "${title}" passed its timelock and executed.` : 'A proposal executed.'
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
    }
  }

  const classifier = CLASSIFIERS[envelope.topic]
  const userId = classifier.userId(envelope)
  return {
    category: classifier.category,
    type: classifier.type,
    userId,
    subjectUrn,
    summary: classifier.summary(envelope),
    amount: amount(envelope) ?? amount(envelope, 'price'),
    assetCode: asset(envelope),
    // A record with no owner cannot be in anybody's feed, whatever the classifier says. Without
    // this, a `settlement.withdrawal.stuck` with no user in its payload would be a `user`-visible
    // record that no user can ever see, which reads on a dashboard as a delivered notification.
    visibility: userId === null ? 'internal' : classifier.visibility,
  }
}

/** Every topic this build classifies. Equal to the registry by construction. */
export const CLASSIFIED_TOPICS: readonly TopicName[] = Object.freeze(
  Object.keys(CLASSIFIERS) as TopicName[],
)

/** Exported so a test can assert the table and the registry have not diverged. */
export const REGISTERED_TOPIC_COUNT = Object.keys(TOPICS).length
