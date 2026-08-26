/**
 * The braces on the reserved-domain rule (micro-org#390).
 *
 * `reserved.test.ts` proves the RULE is right. This file proves the estate would be TOLD if a
 * running build stopped applying it — which is the half that was missing, and the half the leak
 * happened in. The rule had been merged since 2.4.0 and green in CI throughout the six days the
 * mainnet process was sending mail to `beacon.test`.
 *
 * Two independent checks, because they fail in different directions:
 *
 *   `reservedDomainGuardIntact()`  — "would this process route mail to a reserved domain?" Answered
 *                                    before any mail is sent, at every scrape, by driving the real
 *                                    routing function.
 *   `reservedDomainDeliveries()`   — "did it?" Answered from the delivery rows, which is ground
 *                                    truth and does not care what the guard claims.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type postgres from 'postgres'
import { GUARD_CANARY_ADDRESS, ingestEvent, reservedDomainGuardIntact } from './pipeline.ts'
import { isUndeliverableAddress } from './reserved.ts'
import { reservedDomainDeliveries, upsertTarget } from './store.ts'
import {
  ALICE,
  BOB,
  enabled,
  migrateTestDb,
  openDb,
  registeredEvent,
  resetNotify,
  skip,
  testRig,
} from './testsupport.ts'

/* ------------------------------------------------------------------ the self-check */

test('the guard reports the running build refuses to route email to a reserved domain', () => {
  assert.equal(reservedDomainGuardIntact(), true)
})

test('the canary is not the monitor, so a deny-list cannot satisfy the guard', () => {
  // The canary must be reserved — otherwise the guard asserts nothing at all.
  assert.equal(isUndeliverableAddress(GUARD_CANARY_ADDRESS), true)
  // And it must not be under `beacon.test`, nor under `.test` at all. `reserved.ts` argues at
  // length that the rule has to be about the standards rather than about the monitor's chosen
  // name, because the next monitor picks a different one. A canary spelled `beacon.test` would go
  // on reporting 1 for a build whose rule had been narrowed to a deny-list — the guard would
  // certify exactly the regression it exists to catch.
  const domain = GUARD_CANARY_ADDRESS.slice(GUARD_CANARY_ADDRESS.lastIndexOf('@') + 1)
  assert.ok(!domain.endsWith('beacon.test'), 'the canary must not be the monitor domain')
  assert.ok(!domain.endsWith('.test'), 'the canary must not share a TLD with the monitor')
})

/* ------------------------------------------------------------------ the ground truth */

describe('reservedDomainDeliveries', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    if (!enabled) return
    sql = openDb()
    await migrateTestDb(sql)
  })

  beforeEach(async () => {
    if (!enabled) return
    await resetNotify(sql)
  })

  after(async () => {
    if (!enabled) return
    await sql.end({ timeout: 5 })
  })

  /**
   * A delivery row whose recipient is reserved, built the only way one can be.
   *
   * The pipeline refuses to write one — that is the rule working — so the row is made with a
   * deliverable address and the address is then rewritten. That is not a contrivance dodging the
   * rule: it is exactly the shape of the 1,535 rows measured on mainnet, where a build that did
   * not apply the rule wrote delivery rows against targets that were reserved all along.
   */
  async function deliveryTo(address: string, userId: string): Promise<void> {
    await upsertTarget(sql, { userId, channel: 'email', address: 'real@cloudsforge.online' })
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('identity.email.verification_requested', userId, {
        user_id: userId,
        token: 'tok',
      }),
    )
    assert.equal(outcome.kind, 'processed')
    await sql`update channel_targets set address = ${address} where user_id = ${userId}::uuid and channel = 'email'`
  }

  test('counts an email delivery routed to a reserved domain', async () => {
    await deliveryTo('beacon+9f2a@beacon.test', ALICE)
    assert.equal(await reservedDomainDeliveries(sql, 60 * 60_000), 1)
  })

  test('a deliverable recipient is not counted — the correct value is zero', async () => {
    await deliveryTo('someone@cloudsforge.online', ALICE)
    assert.equal(await reservedDomainDeliveries(sql, 60 * 60_000), 0)
  })

  test('counts every reserved TLD, not just the monitor a ticket happened to name', async () => {
    await deliveryTo('a@somewhere.invalid', ALICE)
    await deliveryTo('b@example.com', BOB)
    assert.equal(await reservedDomainDeliveries(sql, 60 * 60_000), 2)
  })

  test('the window bounds it, so a fixed leak clears the alert instead of pinning it on', async () => {
    await deliveryTo('beacon+9f2a@beacon.test', ALICE)
    // A window of zero excludes a row created a moment ago. A gauge that never came back down
    // would be silenced within a week and would be worth nothing the next time.
    assert.equal(await reservedDomainDeliveries(sql, 0), 0)
  })
})
