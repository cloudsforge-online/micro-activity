/**
 * The reserved-domain rule.
 *
 * The negative cases matter more than the positive ones here. `testing.com` and `example.company`
 * are real domains somebody may genuinely use, and the obvious implementations — `endsWith('test')`
 * or `includes('example')` — refuse their mail for ever while passing every positive case in this
 * file. That is the defect this suite exists to catch.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUndeliverableAddress } from './reserved.ts'

test('reserved TLDs are undeliverable', () => {
  // The one that is actually costing the estate its mail allowance.
  assert.equal(isUndeliverableAddress('beacon+9f2a@beacon.test'), true)
  assert.equal(isUndeliverableAddress('a@sub.example.test'), true)
  assert.equal(isUndeliverableAddress('a@anything.invalid'), true)
  // identity writes this when it tombstones an address; it falls out of the same rule for free.
  assert.equal(isUndeliverableAddress('user-1@deleted.invalid'), true)
  assert.equal(isUndeliverableAddress('a@localhost'), true)
  assert.equal(isUndeliverableAddress('a@box.localhost'), true)
  assert.equal(isUndeliverableAddress('a@my.example'), true)
})

test('documentation domains are undeliverable, and so are their subdomains', () => {
  assert.equal(isUndeliverableAddress('a@example.com'), true)
  assert.equal(isUndeliverableAddress('a@example.net'), true)
  assert.equal(isUndeliverableAddress('a@example.org'), true)
  assert.equal(isUndeliverableAddress('a@mx.example.com'), true)
})

test('the domain is case-folded and a trailing dot is the same name', () => {
  assert.equal(isUndeliverableAddress('a@EXAMPLE.COM'), true)
  assert.equal(isUndeliverableAddress('a@Beacon.Test'), true)
  // The fully-qualified spelling. Both forms are one name and only one would otherwise match.
  assert.equal(isUndeliverableAddress('a@beacon.test.'), true)
})

test('a real domain that merely looks like a reserved one is deliverable', () => {
  // The whole reason the check is on the final LABEL and not on a substring.
  assert.equal(isUndeliverableAddress('a@testing.com'), false)
  assert.equal(isUndeliverableAddress('a@example.company'), false)
  assert.equal(isUndeliverableAddress('a@invalidate.co'), false)
  assert.equal(isUndeliverableAddress('a@localhost.com'), false)
  assert.equal(isUndeliverableAddress('a@notexample.com'), false)
})

test('real addresses are deliverable', () => {
  assert.equal(isUndeliverableAddress('a@cloudsforge.online'), false)
  assert.equal(isUndeliverableAddress('savvaniss@yahoo.gr'), false)
  assert.equal(isUndeliverableAddress('no-reply@mail.cloudsforge.online'), false)
})

test('a string that is not an address is treated as undeliverable', () => {
  // Guessing wrong in this direction costs one bounce; guessing wrong the other way spends an
  // allowance real recipients share on a string that was never an address.
  assert.equal(isUndeliverableAddress(''), true)
  assert.equal(isUndeliverableAddress(null), true)
  assert.equal(isUndeliverableAddress(undefined), true)
  assert.equal(isUndeliverableAddress('no-at-sign'), true)
  assert.equal(isUndeliverableAddress('a@'), true)
  assert.equal(isUndeliverableAddress('@beacon.test'), true)
  assert.equal(isUndeliverableAddress('a@.'), true)
})
