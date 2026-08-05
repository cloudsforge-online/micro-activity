/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from the estate's custody service, which is the only
 * place that gets this right today:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic: everything derived from it is forgeable by anyone who can read the
 *      repository, and a placeholder that boots is a placeholder that reaches production.
 */

import { hostname } from 'node:os'
import { assertGeneratedSecretList } from '@cloudsforge/secrets'
import { RETENTION_DAYS, type RetentionClass } from './retention.ts'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'activity'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

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

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * The ingest secrets, newest first.
 *
 * A **list**, because rotation must not require every producer in the estate and this service to
 * change in the same instant. `verifyDelivery` in contracts-events tries each candidate and
 * reports which one matched, so an operator publishes the new secret, both are accepted for a
 * window, and then the old one is removed. A single-secret variable would make every rotation an
 * outage, which is how a secret ends up never being rotated at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PER-ENTRY `PLACEHOLDERS` SET AND 24-CHARACTER FLOOR USED TO LIVE HERE, AND THEY ARE GONE
 * RATHER THAN KEPT IN FRONT OF THE SHAPE CHECK.**
 *
 * `ACTIVITY_INGEST_SECRETS` is one of the seven names the estate spells a single shared HMAC key
 * under, and that key sat in a PUBLIC compose file as `estate-only-outbox-secret-00000000000000`
 * on 54 lines. The old rule here — a fixed deny-list of exact strings plus a 24-character floor —
 * could not have refused it: 40 characters, and on nobody's list. A check that could not fail read
 * as the absence of a problem, which is worse than no check at all (micro-org #142).
 *
 * A deny-list of exact strings cannot work, because the next placeholder somebody writes is by
 * definition not on it. `assertGeneratedSecretList` asserts what a placeholder cannot have, per
 * entry: the base64 or hex alphabet (no hyphens — every placeholder this estate wrote had one), 32
 * decoded BYTES rather than 24 keystrokes, and a measured Shannon entropy floor. Every string the
 * old set held is refused by that anyway, and running the weaker rule first would answer a
 * 40-character placeholder with "must be at least 24 characters" — true, useless, and about the
 * wrong property.
 *
 * **Every entry, including the outgoing one.** In a rotation overlap window the outgoing key is the
 * one an attacker already holds if it leaked, and "just for the drain" is exactly how a placeholder
 * survives the rotation meant to remove it.
 *
 * This is the check that stands between an unauthenticated POST and the canonical record of what
 * happened to a user's money, so there is no NODE_ENV exemption and no escape hatch. What is kept
 * is what the shape check does not know about: this service's own empty and four-deep refusals,
 * whose messages name the variable and this service.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function requiredSecrets(source: Source, name: string): readonly string[] {
  const raw = required(source, name)
  const secrets = raw
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0)
  if (secrets.length === 0) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  if (secrets.length > 4) throw new EnvError(`${name} carries more than four secrets; a rotation is not four deep`)
  assertGeneratedSecretList(name, secrets)
  return Object.freeze(secrets)
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
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * HMAC keys accepted on `POST /ingest`, newest first.
   *
   * This is the check that stands between an unauthenticated POST and the canonical record of
   * what happened to a user's money. It is not the only check — a service token is required too —
   * but it is the one that proves the *body* was not altered between the producer's outbox and
   * this handler.
   */
  readonly ingestSecrets: readonly string[]
  /**
   * How much clock skew and relay delay a delivery signature may carry, in milliseconds.
   *
   * Defaults to `DELIVERY_TOLERANCE_MS` from contracts-events. Configurable only downwards in
   * practice: a wider window makes a captured request a longer-lived credential.
   */
  readonly deliveryToleranceMs: number
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes.
   */
  readonly instanceId: string
  /** How long a processed inbox row is kept. Must outlive every producer's retry horizon. */
  readonly inboxRetentionDays: number
  /**
   * How long a RECORD is kept, by retention class, in days.
   *
   * The periods and the basis for each are in `src/retention.ts`; what is worth stating here is the
   * shape of the bounds. **Each maximum is the default.** A deployment may shorten a period — a
   * stricter jurisdiction, a tenant who asked for less — and cannot lengthen one, so the numbers in
   * `retention.ts` are an upper bound on what any deployment of this service retains rather than a
   * suggestion it is free to ignore. `ACTIVITY_RETENTION_FINANCIAL_DAYS=3650` is refused by name at
   * boot, which is the difference between a policy and a comment.
   *
   * The one that is not merely a knob is `financial`: five years is an AML/CTF record-keeping
   * obligation, so its floor is a year rather than a week. Shortening it below that is a decision
   * for a lawyer and not for an environment variable.
   */
  readonly retentionDays: Readonly<Record<RetentionClass, number>>
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
  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'ACTIVITY_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'ACTIVITY_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    ingestSecrets: requiredSecrets(source, 'ACTIVITY_INGEST_SECRETS'),
    deliveryToleranceMs: integer(source, 'ACTIVITY_DELIVERY_TOLERANCE_MS', 300_000, 5_000, 900_000),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    inboxRetentionDays: integer(source, 'ACTIVITY_INBOX_RETENTION_DAYS', 30, 7, 365),
    // The maximum is the default in every one of the four — see the field's note above.
    retentionDays: Object.freeze({
      financial: integer(
        source,
        'ACTIVITY_RETENTION_FINANCIAL_DAYS',
        RETENTION_DAYS.financial,
        365,
        RETENTION_DAYS.financial,
      ),
      personal: integer(
        source,
        'ACTIVITY_RETENTION_PERSONAL_DAYS',
        RETENTION_DAYS.personal,
        30,
        RETENTION_DAYS.personal,
      ),
      operational: integer(
        source,
        'ACTIVITY_RETENTION_OPERATIONAL_DAYS',
        RETENTION_DAYS.operational,
        30,
        RETENTION_DAYS.operational,
      ),
      quarantine: integer(
        source,
        'ACTIVITY_RETENTION_QUARANTINE_DAYS',
        RETENTION_DAYS.quarantine,
        7,
        RETENTION_DAYS.quarantine,
      ),
    }),
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
