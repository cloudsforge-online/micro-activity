/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so the failure paths are testable without mutating the
 * process — which is the only way to test "this refuses to boot" without a boot.
 *
 * The theme of these tests is the distinction the whole file exists to draw: **a missing
 * transport is fine; a missing or weak secret is fatal.** Getting that backwards either takes a
 * whole product down because nobody bought an SMS provider, or ships an ingest endpoint that
 * accepts anything.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

// 32 BYTES of key material, not 32 characters. The previous fixture was 32 mixed-alphabet
// characters carrying 24 bytes, which the old length floor accepted and the measuring guard
// refuses — the fixture was built to the wrong unit, so it pinned the wrong bar.
const SECRET = 'TIBeym3hcFJ0Pw/p6XnxmihdgF91LV3EoKint5+Stfg='

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. Note what
 * is *absent*: every SMTP and gateway variable. A deployment that sends no mail must boot, and
 * this file booting is the proof.
 */
const MINIMAL: Record<string, string> = {
  NOTIFY_DATABASE_URL: 'postgres://notify:notify@127.0.0.1:5432/notify',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  NOTIFY_INGEST_SIGNING_SECRET: SECRET,
  NOTIFY_PUBLIC_URL: 'https://app.cloudsforge.test',
}
for (const [key, value] of Object.entries(MINIMAL)) process.env[key] = value

const { EnvError, SERVICE, env: eager, loadEnv, transportSummary } = await import('./env.ts')

test('the minimal environment boots, and no transport is configured', () => {
  const env = loadEnv(MINIMAL, 'host-1')
  assert.equal(env.port, 4012)
  assert.equal(env.smtp.host, null)
  assert.equal(env.gateways.smsUrl, null)
  assert.equal(env.instanceId, 'host-1')
  // The eager export exists, which means importing the module did not exit.
  assert.equal(SERVICE, 'notify')
  assert.equal(eager.databaseUrl, MINIMAL['NOTIFY_DATABASE_URL'])
})

test('a deployment with no SMTP is a supported deployment', () => {
  // The estate's own precedent, and the property `email.ts` depends on. This is a *test that it
  // does not throw*, which is the whole point.
  const env = loadEnv(MINIMAL)
  assert.deepEqual(transportSummary(env), {
    in_app: true,
    email: false,
    web_push: false,
    mobile_push: false,
    sms: false,
    webhook: true,
  })
})

test('SMTP host plus From makes email a configured transport', () => {
  const env = loadEnv({
    ...MINIMAL,
    SMTP_HOST: 'smtp-relay.example.test',
    SMTP_FROM: 'CloudsForge <no-reply@example.test>',
    SMTP_USER: 'user',
    SMTP_PASS: 'pass',
  })
  assert.equal(transportSummary(env).email, true)
  assert.equal(env.smtp.port, 587)
  assert.equal(env.smtp.secure, false)
})

test('a missing required variable names itself', () => {
  for (const name of Object.keys(MINIMAL)) {
    const source = { ...MINIMAL }
    delete source[name]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => err instanceof EnvError && err.message.includes(name),
      `${name} did not name itself`,
    )
  }
})

test('a placeholder ingest secret is refused outright', () => {
  for (const placeholder of ['changeme', 'dev-secret', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']) {
    assert.throws(
      () => loadEnv({ ...MINIMAL, NOTIFY_INGEST_SIGNING_SECRET: placeholder }),
      EnvError,
      placeholder,
    )
  }
})

test('a short ingest secret is refused', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, NOTIFY_INGEST_SIGNING_SECRET: 'too-short' }), EnvError)
})

test('rotation is supported, and every candidate must stand on its own', () => {
  const older = 'cAUXCjNaVTKSPlFisKkfwQvY7zZ5J1xHTpOti/pPIEo='
  const env = loadEnv({ ...MINIMAL, NOTIFY_INGEST_SIGNING_SECRET: `${SECRET},${older}` })
  assert.deepEqual(env.ingestSigningSecrets, [SECRET, older])

  // A weak candidate hiding behind a strong one is the exact shape this check exists to catch:
  // either secret can authenticate an ingest that mints a security notice.
  assert.throws(
    () => loadEnv({ ...MINIMAL, NOTIFY_INGEST_SIGNING_SECRET: `${SECRET},weak` }),
    EnvError,
  )
})

test('an out-of-range number is refused rather than clamped', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, NOTIFY_DATABASE_POOL_MAX: '0' }), EnvError)
  assert.throws(() => loadEnv({ ...MINIMAL, NOTIFY_DELIVERY_MAX_ATTEMPTS: '100' }), EnvError)
  assert.throws(() => loadEnv({ ...MINIMAL, PORT: 'four thousand' }), EnvError)
})

test('an unknown log level is refused', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, LOG_LEVEL: 'verbose' }), EnvError)
})

test('SMTP_SECURE only accepts a boolean spelling', () => {
  assert.equal(loadEnv({ ...MINIMAL, SMTP_SECURE: 'true' }).smtp.secure, true)
  assert.equal(loadEnv({ ...MINIMAL, SMTP_SECURE: '1' }).smtp.secure, true)
  assert.throws(() => loadEnv({ ...MINIMAL, SMTP_SECURE: 'yes' }), EnvError)
})

test('the transport summary names channels and never a credential', () => {
  const env = loadEnv({
    ...MINIMAL,
    SMTP_HOST: 'smtp.example.test',
    SMTP_FROM: 'a@b.test',
    SMTP_PASS: 'a-real-looking-password',
    NOTIFY_GATEWAY_TOKEN: 'a-real-looking-token',
  })
  const rendered = JSON.stringify(transportSummary(env))
  assert.doesNotMatch(rendered, /a-real-looking-password/)
  assert.doesNotMatch(rendered, /a-real-looking-token/)
  assert.doesNotMatch(rendered, /smtp\.example\.test/)
})
