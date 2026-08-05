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
import { RETENTION_DAYS } from './retention.ts'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The failure
 * cases below go through `loadEnv`, which is pure over its source and therefore testable without a
 * child process.
 */
const BASE: Record<string, string> = {
  ACTIVITY_DATABASE_URL: 'postgres://activity:activity@127.0.0.1:5432/activity',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  ACTIVITY_INGEST_SECRETS: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const { EnvError, SERVICE, env: eager, loadEnv } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(SERVICE, 'activity')
  assert.equal(eager.databaseUrl, BASE['ACTIVITY_DATABASE_URL'])
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
