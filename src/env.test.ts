/**
 * Configuration, and the one property of it that is a compliance control rather than a knob.
 *
 * The retention periods are the reason this file exists. Every other variable here is an operator's
 * choice; `ACTIVITY_RETENTION_*_DAYS` is a bound on how long this service keeps personal data, and
 * a bound a deployment can raise is not a bound. So the assertions below are written against the
 * two things that must stay true whatever anybody configures: **an unconfigured estate still
 * enforces a period**, and **no environment can lengthen one**.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { RETENTION_DAYS } from './retention.ts'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The failure
 * cases below go through `loadEnv`, which is pure over its source and therefore testable without a
 * child process.
 *
 * The ingest secret is GENERATED rather than written. It used to be the literal
 * `K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4` — 32 characters, on no deny-list, comfortably over the old
 * 24-character floor, and carrying 24 bytes of key material. That is the same shape as
 * `estate-only-outbox-secret-00000000000000`, which sat on 54 lines of a PUBLIC compose file and
 * passed every guard in the estate (micro-org #142). A fixture exempt from the rule it exercises
 * is how that survived every test in the estate, so this one is not exempt: it is generated per
 * run, and the old literal is now asserted below to be REFUSED.
 */
const BASE: Record<string, string> = {
  ACTIVITY_DATABASE_URL: 'postgres://activity:activity@127.0.0.1:5432/activity',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  ACTIVITY_INGEST_SECRETS: randomBytes(48).toString('base64'),
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const { EnvError, SERVICE, env: eager, loadEnv } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(SERVICE, 'activity')
  assert.equal(eager.databaseUrl, BASE['ACTIVITY_DATABASE_URL'])
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * micro-org #142. The shape check, against the strings that were actually deployed.
 *
 * `ACTIVITY_INGEST_SECRETS` is one of the seven names the estate spells a single shared HMAC key
 * under, and it is the check that stands between an unauthenticated POST and the canonical record
 * of what happened to a user's money. This service reads no scalar `OUTBOX_SIGNING_SECRET` — it
 * publishes nothing — so the list IS the whole surface here.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Real strings, not invented ones: each was deployed or set in CI, and each cleared the old guard —
 * a deny-list of exact strings plus a 24-character floor — because it was on no list and was long
 * enough. If a future edit weakens the floor it fails against evidence rather than against taste.
 */
const DEPLOYED_PLACEHOLDERS = [
  'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
  'ci-only-not-a-real-secret-000000000000', // this repository's own former CI value
  'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // this file's own former fixture: 32 chars, 24 bytes
  '0'.repeat(64), // right alphabet, right length, no entropy at all
] as const

/** Names the variable, names the fix, and carries no part of the value. */
function refusalIsSafe(err: unknown, value: string): true {
  const message = (err as Error).message
  // The reason this guard exists is that the value was readable. A message carrying it would move
  // the secret from one public place to the log collector.
  assert.ok(!message.includes(value), 'the refusal echoed the value')
  assert.match(message, /ACTIVITY_INGEST_SECRETS/)
  assert.match(message, /openssl rand -base64 48/)
  return true
}

test('THE VALUES THAT SAT IN A PUBLIC REPOSITORY ARE REFUSED, as the only entry', () => {
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...BASE, ACTIVITY_INGEST_SECRETS: value }),
      (err: unknown) => refusalIsSafe(err, value),
      `${value.slice(0, 6)}… was accepted as ACTIVITY_INGEST_SECRETS`,
    )
  }
})

test('THE SAME BAR ON A LIST ENTRY — a rotation window is not a place the rule relaxes', () => {
  // The OUTGOING key is the one an attacker already holds if it leaked, so "just for the drain" is
  // exactly how a placeholder survives the rotation that was supposed to remove it. Second position
  // on purpose: the first entry being genuine must not vouch for the rest.
  const good = randomBytes(48).toString('base64')
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...BASE, ACTIVITY_INGEST_SECRETS: `${good},${value}` }),
      (err: unknown) => {
        assert.ok(!(err as Error).message.includes(good), 'the refusal echoed the good key beside it')
        return refusalIsSafe(err, value)
      },
      `${value.slice(0, 6)}… was accepted as a second ACTIVITY_INGEST_SECRETS entry`,
    )
  }
})

test('the list rules this service owns are kept, and still name this service', () => {
  // The shape check does not know about either of these, so neither was replaced by it.
  const good = () => randomBytes(48).toString('base64')
  assert.throws(() => loadEnv({ ...BASE, ACTIVITY_INGEST_SECRETS: ' , , ' }), /ACTIVITY_INGEST_SECRETS is required/)
  assert.throws(
    () => loadEnv({ ...BASE, ACTIVITY_INGEST_SECRETS: [good(), good(), good(), good(), good()].join(',') }),
    /a rotation is not four deep/,
  )
})

test('a generated secret is accepted, in either alphabet', () => {
  // The floors are measured rather than guessed, so a guard that occasionally refused correct input
  // — which is a guard somebody removes — would show up here.
  assert.doesNotThrow(() =>
    loadEnv({
      ...BASE,
      ACTIVITY_INGEST_SECRETS: `${randomBytes(48).toString('base64')},${randomBytes(32).toString('hex')}`,
    }),
  )
})

test('THE RULE: an unconfigured deployment still enforces a retention period', () => {
  // The failure this refuses is the quiet one: a service that reads a period from the environment,
  // finds nothing, and keeps everything for ever while every dashboard reports it as healthy. The
  // defaults ARE the policy in `retention.ts`, so nothing has to be set for the policy to apply.
  assert.deepEqual(loadEnv(BASE).retentionDays, RETENTION_DAYS)
  assert.deepEqual(eager.retentionDays, RETENTION_DAYS)
})

test('THE RULE: a deployment may shorten a retention period and may never lengthen one', () => {
  // Each variable's MAXIMUM is its default, which is what makes the numbers in `retention.ts` an
  // upper bound on every deployment rather than a suggestion. Without this, "five years" would mean
  // "five years unless somebody set a variable", and nothing in the estate would say which.
  assert.equal(loadEnv({ ...BASE, ACTIVITY_RETENTION_FINANCIAL_DAYS: '400' }).retentionDays.financial, 400)
  assert.equal(loadEnv({ ...BASE, ACTIVITY_RETENTION_QUARANTINE_DAYS: '7' }).retentionDays.quarantine, 7)

  for (const [name, days] of [
    ['ACTIVITY_RETENTION_FINANCIAL_DAYS', RETENTION_DAYS.financial],
    ['ACTIVITY_RETENTION_PERSONAL_DAYS', RETENTION_DAYS.personal],
    ['ACTIVITY_RETENTION_OPERATIONAL_DAYS', RETENTION_DAYS.operational],
    ['ACTIVITY_RETENTION_QUARANTINE_DAYS', RETENTION_DAYS.quarantine],
  ] as const) {
    assert.throws(
      () => loadEnv({ ...BASE, [name]: String(days + 1) }),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /must be a whole number between/)
        return true
      },
      `${name} accepted a period longer than the policy`,
    )
  }

  // The financial floor is a year rather than a week: five years is an AML/CTF record-keeping
  // obligation, and shortening it is a decision for a lawyer and not for an environment variable.
  assert.throws(() => loadEnv({ ...BASE, ACTIVITY_RETENTION_FINANCIAL_DAYS: '30' }), EnvError)
})
