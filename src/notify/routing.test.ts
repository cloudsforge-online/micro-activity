/**
 * The invariant, tested exhaustively.
 *
 * `resolveRouting` is pure, so §10.3 can be checked against *every* combination of preference
 * rather than against one representative case. That is the point of keeping it free of the
 * database: "a user cannot opt out of being told their key left" is a claim about all possible
 * settings, and a test that checks one setting is a test that proves almost nothing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CATEGORIES,
  CHANNELS,
  DIGESTS,
  PRIORITIES,
  type Channel,
  type Digest,
  type Priority,
} from './model.ts'
import {
  DAILY_DIGEST_HOUR_UTC,
  applyPreferences,
  nextDigestWindow,
  resolveRouting,
  type Preference,
} from './routing.ts'

const EVERY_CHANNEL: readonly Channel[] = CHANNELS

/** Every channel switched off, muted and batched into oblivion, for every category. */
function everythingDisabled(): Preference[] {
  const preferences: Preference[] = []
  for (const category of CATEGORIES) {
    for (const channel of CHANNELS) {
      preferences.push({
        category,
        channel,
        enabled: false,
        digest: 'off',
        minPriority: 'critical',
      })
    }
  }
  return preferences
}

test('a critical notification is delivered with every preference disabled', () => {
  const routing = resolveRouting({
    priority: 'critical',
    category: 'security',
    availableChannels: EVERY_CHANNEL,
    preferences: everythingDisabled(),
  })

  assert.equal(routing.kind, 'deliver')
  if (routing.kind !== 'deliver') return
  assert.ok(routing.routes.length >= 1, 'at least one channel — 04-domain-model §10.3')
  // Not merely "at least one": everything reachable, and all of it instantly. A digest preference
  // must not be able to delay a security alert either.
  assert.equal(routing.routes.length, CHANNELS.length)
  assert.ok(routing.routes.every((route) => route.when === 'instant'))
})

test('a critical notification survives every single-preference combination there is', () => {
  // The exhaustive form. 4 * 4 * 2 = 32 preference shapes per channel, applied to every channel
  // at once, across every category — if any of them could suppress a critical notification this
  // fails, and no representative sample can make that promise.
  for (const digest of DIGESTS) {
    for (const minPriority of PRIORITIES) {
      for (const enabled of [true, false]) {
        const preferences = CATEGORIES.flatMap((category) =>
          CHANNELS.map((channel) => ({ category, channel, enabled, digest, minPriority })),
        )
        const routing = resolveRouting({
          priority: 'critical',
          category: 'security',
          availableChannels: EVERY_CHANNEL,
          preferences,
        })
        assert.equal(
          routing.kind,
          'deliver',
          `critical was suppressed with enabled=${enabled} digest=${digest} min=${minPriority}`,
        )
      }
    }
  }
})

test('a critical notification is delivered to a user with no channels at all', () => {
  // The floor. No email on file, no push token, no phone number, no webhook — in-app is still
  // there, because it needs no address and no transport.
  const routing = resolveRouting({
    priority: 'critical',
    category: 'security',
    availableChannels: [],
    preferences: everythingDisabled(),
  })
  assert.equal(routing.kind, 'deliver')
  if (routing.kind !== 'deliver') return
  assert.deepEqual(
    routing.routes.map((route) => route.channel),
    ['in_app'],
  )
})

test('a non-critical notification is suppressed when every channel is disabled', () => {
  const routing = resolveRouting({
    priority: 'high',
    category: 'market',
    availableChannels: EVERY_CHANNEL,
    preferences: CHANNELS.map((channel) => ({
      category: 'market' as const,
      channel,
      enabled: false,
      digest: 'instant' as Digest,
      minPriority: 'low' as Priority,
    })),
  })
  assert.deepEqual(routing, { kind: 'suppressed', reason: 'channel_disabled' })
})

test('min_priority suppresses below its threshold and passes at or above it', () => {
  const preferences = CHANNELS.map((channel) => ({
    category: 'market' as const,
    channel,
    enabled: true,
    digest: 'instant' as Digest,
    minPriority: 'high' as Priority,
  }))

  const low = resolveRouting({
    priority: 'normal',
    category: 'market',
    availableChannels: EVERY_CHANNEL,
    preferences,
  })
  assert.deepEqual(low, { kind: 'suppressed', reason: 'below_min_priority' })

  const high = resolveRouting({
    priority: 'high',
    category: 'market',
    availableChannels: EVERY_CHANNEL,
    preferences,
  })
  assert.equal(high.kind, 'deliver')
})

test('digest off suppresses, and reports itself as such rather than as a disabled channel', () => {
  const routing = resolveRouting({
    priority: 'normal',
    category: 'market',
    availableChannels: EVERY_CHANNEL,
    preferences: CHANNELS.map((channel) => ({
      category: 'market' as const,
      channel,
      enabled: true,
      digest: 'off' as Digest,
      minPriority: 'low' as Priority,
    })),
  })
  assert.deepEqual(routing, { kind: 'suppressed', reason: 'digest_off' })
})

test('a mixture of causes reports "preferences" rather than whichever came first', () => {
  const preferences: Preference[] = [
    { category: 'market', channel: 'in_app', enabled: false, digest: 'instant', minPriority: 'low' },
    { category: 'market', channel: 'email', enabled: true, digest: 'off', minPriority: 'low' },
  ]
  const routing = resolveRouting({
    priority: 'normal',
    category: 'market',
    availableChannels: ['in_app', 'email'],
    preferences,
  })
  assert.deepEqual(routing, { kind: 'suppressed', reason: 'preferences' })
})

test('a preference for another category does not affect this one', () => {
  const routing = resolveRouting({
    priority: 'normal',
    category: 'market',
    availableChannels: ['in_app'],
    preferences: [
      { category: 'security', channel: 'in_app', enabled: false, digest: 'off', minPriority: 'critical' },
    ],
  })
  assert.equal(routing.kind, 'deliver')
})

test('an absent preference defaults to enabled, instant and low', () => {
  const routing = resolveRouting({
    priority: 'low',
    category: 'reward',
    availableChannels: ['in_app', 'email'],
    preferences: [],
  })
  assert.equal(routing.kind, 'deliver')
  if (routing.kind !== 'deliver') return
  assert.deepEqual(new Set(routing.routes.map((r) => r.when)), new Set(['instant']))
})

test('a digest preference routes to a cadence rather than to an instant delivery', () => {
  const routing = resolveRouting({
    priority: 'normal',
    category: 'transfer',
    availableChannels: ['in_app', 'email'],
    preferences: [
      { category: 'transfer', channel: 'email', enabled: true, digest: 'daily', minPriority: 'low' },
      { category: 'transfer', channel: 'in_app', enabled: true, digest: 'hourly', minPriority: 'low' },
    ],
  })
  assert.equal(routing.kind, 'deliver')
  if (routing.kind !== 'deliver') return
  const byChannel = new Map(routing.routes.map((route) => [route.channel, route.when]))
  assert.equal(byChannel.get('email'), 'daily')
  assert.equal(byChannel.get('in_app'), 'hourly')
})

test('applyPreferences cannot be reached with a critical priority', () => {
  // The type-level half of the invariant. The line below is the test: uncomment the `@ts-expect-
  // error` case and the build fails, which is the whole point — a preference filter that cannot
  // be handed a critical notification cannot suppress one.
  // @ts-expect-error 'critical' is not assignable to NonCriticalPriority
  const call = () => applyPreferences('critical', 'security', new Set(['in_app']), [])
  assert.equal(typeof call, 'function')
})

test('the hourly digest window is the top of the next hour', () => {
  const now = new Date('2026-07-30T04:37:12.500Z')
  assert.equal(nextDigestWindow('hourly', now).toISOString(), '2026-07-30T05:00:00.000Z')
})

test('the daily digest window is the next 09:00 UTC, never the small hours', () => {
  const morning = nextDigestWindow('daily', new Date('2026-07-30T03:00:00.000Z'))
  assert.equal(morning.toISOString(), `2026-07-30T0${DAILY_DIGEST_HOUR_UTC}:00:00.000Z`)

  // After the hour has passed, it is tomorrow's — not "in twenty-four hours", which would drift
  // the window a little later every day until a daily digest arrived at midnight.
  const afternoon = nextDigestWindow('daily', new Date('2026-07-30T14:00:00.000Z'))
  assert.equal(afternoon.toISOString(), `2026-07-31T0${DAILY_DIGEST_HOUR_UTC}:00:00.000Z`)
})

test('a channel with no address is not routed to', () => {
  const routing = resolveRouting({
    priority: 'normal',
    category: 'market',
    availableChannels: ['in_app'],
    preferences: [],
  })
  assert.equal(routing.kind, 'deliver')
  if (routing.kind !== 'deliver') return
  assert.deepEqual(
    routing.routes.map((route) => route.channel),
    ['in_app'],
  )
})
