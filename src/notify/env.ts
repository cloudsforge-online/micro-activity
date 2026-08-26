/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it.
 *
 * **The one thing to understand before editing this file: an unconfigured transport is a
 * supported mode, not a misconfiguration.** SMTP is the estate's precedent — the current
 * `.env.example` says "Unset = no mail … which is how it worked before this existed and is a
 * supported way to run" — and the same rule is extended here to web push, mobile push and SMS.
 * A missing transport makes a delivery `undeliverable_no_transport`: a retained row an operator
 * can count, never a boot failure and never a dropped notification. Refusing to start because
 * nobody has bought an SMS provider yet would take the whole notification pipeline down to
 * protect a channel almost nothing uses.
 *
 * What is *not* optional is anything that authenticates. `NOTIFY_INGEST_SIGNING_SECRET` is
 * refused if absent or placeholder, because an ingest endpoint that accepts an unsigned POST is
 * an endpoint on which anyone can mint a "your key was exported" notice for any user.
 */

import { hostname } from 'node:os'

import { assertGeneratedSecretList } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'notify'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * The deny-list that used to live here is gone, and it is worth saying why rather than leaving a
 * gap. It listed eight strings and required 24 characters. Both were cleared by
 * `estate-only-outbox-secret-` padded with zeros, which ran as a LIVE signing key across 44
 * containers on both networks: 40 characters, and not the ninth string anyone had thought of.
 *
 * A membership test can only refuse placeholders someone already imagined, so it fails in exactly
 * the case that matters — a new one. And length is not entropy: `'x'.repeat(24)` clears a 24-char
 * floor and carries almost no key material at all.
 *
 * `@cloudsforge/secrets` measures bytes of key material for the alphabet the value is written in,
 * so it refuses both without needing to have met them before.
 */
type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

/** Absent means "this feature is not configured", which is a supported state, not a default. */
function absent(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : null
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

/**
 * SMTP, as the estate already spells it.
 *
 * `host === null` is the unconfigured mode. Everything else is only read when the host is set,
 * which is the rule the current `.env.example` states and this reproduces exactly — so moving
 * between providers stays an edit to four variables and a restart, with no provider SDK anywhere.
 */
export interface SmtpConfig {
  readonly host: string | null
  readonly port: number
  readonly secure: boolean
  readonly user: string | null
  readonly pass: string | null
  readonly from: string | null
  readonly replyTo: string | null
}

/**
 * Where a push or SMS gateway lives.
 *
 * These three channels have no provider in the estate today, and this service deliberately does
 * not invent one: each adapter posts a rendered message to a gateway URL. That keeps the adapter
 * boundary honest — swapping in VAPID, APNs or a telco is one file — without pretending a
 * provider integration exists that has never been tested against a real endpoint.
 */
export interface GatewayConfig {
  readonly webPushUrl: string | null
  readonly mobilePushUrl: string | null
  readonly smsUrl: string | null
  /** Presented as a bearer token to whichever of the three are configured. */
  readonly token: string | null
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  /**
   * `CF_NETWORK_SINGLE`: the estate to assume when no `CF-Network` arrives. For `pnpm dev`, which
   * has no gateway. NEVER set in production.
   *
   * NOT a database selector — notify keeps one pipeline, one quota and one dead-letter view. It
   * decides what goes in `deliveries.network`. See micro-deploy `docs/network-consolidation.md`.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * Verifies the `cf-signature` header on `POST /ingest`.
   *
   * A list, because rotation must not require every producer in the estate to change secret in
   * the same instant: publish the new one, accept both for a window, drop the old one. Comma
   * separated, most-recent first.
   */
  readonly ingestSigningSecrets: readonly string[]
  /**
   * The origin that links inside a notification are built from.
   *
   * Never the request's Host header. Identity was burned by exactly that: an attacker who knew a
   * victim's address had the deployment's own relay send them a genuine email pointing at a host
   * the sender chose.
   */
  readonly publicUrl: string
  /** How many times a retryable delivery failure is retried before the row dead-letters. */
  readonly deliveryMaxAttempts: number
  /** How many due deliveries one dispatch pass claims. */
  readonly dispatchBatchSize: number
  readonly smtp: SmtpConfig
  readonly gateways: GatewayConfig
  /**
   * Names this replica in `jobs.locked_by` and in `deliveries.leased_by`. Defaults to the
   * hostname, which is the container id under compose and the pod name under Kubernetes — in both
   * cases the thing an operator would search for after finding a stuck lease.
   */
  readonly instanceId: string
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const raw = source['NOTIFY_INGEST_SIGNING_SECRET']
  if (raw === undefined || raw.trim() === '') {
    throw new EnvError('NOTIFY_INGEST_SIGNING_SECRET is required')
  }
  const secrets = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (secrets.length === 0) {
    throw new EnvError('NOTIFY_INGEST_SIGNING_SECRET is required')
  }
  // Splitting before the check, not after: `a,<32 real chars>` would otherwise pass on the strength
  // of the real one. Every candidate stands on its own, because any of them can authenticate an
  // ingest that mints a security notice.
  //
  // The bar is BYTES OF KEY MATERIAL, not characters. A length floor plus a deny-list is what let
  // `estate-only-outbox-secret-` + zeros run as a live signing key across 44 containers: 40
  // characters cleared the floor, and it was not the ninth string anyone had thought to list. A
  // membership test only catches placeholders somebody already imagined, which is precisely the
  // case where it is not needed.
  // Re-wrapped, not re-thrown. `loadEnv` promises one error class, and a caller that catches
  // `EnvError` should not start seeing a second one because the check underneath got better. The
  // message is carried verbatim, so the boot line an operator reads is the guard's own words.
  try {
    assertGeneratedSecretList('NOTIFY_INGEST_SIGNING_SECRET', secrets)
  } catch (err) {
    throw new EnvError(err instanceof Error ? err.message : String(err))
  }

  const smtpHost = absent(source, 'SMTP_HOST')
  return {
    port: integer(source, 'PORT', 4012, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'NOTIFY_DATABASE_URL'),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'NOTIFY_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    ingestSigningSecrets: secrets,
    publicUrl: required(source, 'NOTIFY_PUBLIC_URL'),
    deliveryMaxAttempts: integer(source, 'NOTIFY_DELIVERY_MAX_ATTEMPTS', 6, 1, 20),
    dispatchBatchSize: integer(source, 'NOTIFY_DISPATCH_BATCH_SIZE', 50, 1, 500),
    smtp: {
      host: smtpHost,
      // 587 is STARTTLS and is what every provider documents first. 465 is implicit TLS and
      // additionally needs SMTP_SECURE=true; the two are not interchangeable, and 465 with
      // secure unset hangs until the connect timeout.
      port: integer(source, 'SMTP_PORT', 587, 1, 65_535),
      secure: boolean(source, 'SMTP_SECURE', false),
      user: absent(source, 'SMTP_USER'),
      pass: absent(source, 'SMTP_PASS'),
      from: absent(source, 'SMTP_FROM'),
      replyTo: absent(source, 'SMTP_REPLY_TO'),
    },
    gateways: {
      webPushUrl: absent(source, 'NOTIFY_WEBPUSH_URL'),
      mobilePushUrl: absent(source, 'NOTIFY_MOBILEPUSH_URL'),
      smsUrl: absent(source, 'NOTIFY_SMS_URL'),
      token: absent(source, 'NOTIFY_GATEWAY_TOKEN'),
    },
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
  }
}

/**
 * A one-line summary of which transports exist, for the boot log.
 *
 * Nimbus already does this and it is the single most useful line in its output: "did this
 * deployment send that email, or did it record the request and stay silent" is otherwise
 * answered by reading configuration on a host you may not have.
 *
 * It names channels, never credentials.
 */
export function transportSummary(env: Env): Record<string, boolean> {
  return {
    in_app: true,
    email: env.smtp.host !== null && env.smtp.from !== null,
    web_push: env.gateways.webPushUrl !== null,
    mobile_push: env.gateways.mobilePushUrl !== null,
    sms: env.gateways.smsUrl !== null,
    // Per-endpoint, so it is configured by a row rather than by the environment. Always available.
    webhook: true,
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed
 * through the telemetry package: nothing that can itself fail may sit between a configuration
 * error and the report of it. The message is the one `loadEnv` produced, which by construction
 * never contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
