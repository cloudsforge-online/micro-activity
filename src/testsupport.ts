/**
 * Shared setup for the database tests, and the delivery builder.
 *
 * **A database test runs only against a database whose name says it is a test database.** That is
 * not a convenience: `resetActivity` truncates every table in the schema, and requiring "test" in
 * the name is the difference between a red build and an emptied environment.
 *
 * `delivery()` builds and signs an event with the real `makeEvent`, `serialiseEvent` and
 * `signDelivery` from `@cloudsforge/contracts-events`. Nothing here hand-rolls an envelope or a
 * signature: a test that signed with its own implementation would pass against a service that had
 * stopped agreeing with the contract, which is the single failure this whole package exists to
 * prevent.
 *
 * Not a test file itself — it is excluded from the build and contains no `test()` call.
 */

import postgres from 'postgres'
import {
  eventId,
  makeEvent,
  serialiseEvent,
  signDelivery,
  type Actor,
  type EventEnvelope,
  type TopicName,
} from '@cloudsforge/contracts-events'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import { MIGRATIONS } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import type { IngestDeps } from './ingest.ts'
import type { Db } from './records.ts'

const url = process.env['ACTIVITY_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set ACTIVITY_TEST_DATABASE_URL (name must contain "test")'

/** Long enough to pass the length check in `env.ts`, and random-looking enough not to be copied. */
export const SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'
export const ROTATED_OUT_SECRET = 'Q7mZ2xV5bN8kL1jH4gF6dS9aP3wE0rT2'

const ALL_TABLES = ['activity_records', 'inbox', 'jobs'].join(', ')

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints the tests are supposed to prove — the unique `source_event_id`, the
 * category CHECK, the immutability trigger — drift away from the ones a deployment has.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'activity-test' })
}

export async function resetActivity(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${ALL_TABLES} restart identity cascade`)
}

/** A quiet logger. Discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'activity-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(registerHttpMetrics(new Metrics()))
}

export function ingestDeps(sql: Db, options: { readonly now?: () => number } = {}): IngestDeps {
  return {
    sql,
    logger: quietLogger(),
    metrics: testMetrics(),
    secrets: [SECRET],
    ...(options.now ? { now: options.now } : {}),
  }
}

/* ------------------------------------------------------------------ deliveries */

export interface Delivery {
  readonly body: string
  readonly signature: string
  readonly envelope: EventEnvelope
}

export interface DeliveryOptions {
  readonly topic: TopicName
  readonly key: string
  readonly payload?: Record<string, unknown>
  readonly actor?: Actor
  readonly correlationId?: string
  readonly occurredAt?: Date
  /** Supplied to build a *redelivery*: the same event, signed again. */
  readonly id?: string
  /** When the signature was made. Used to test the freshness window. */
  readonly signedAt?: number
  readonly secret?: string
}

/** Build and sign one delivery, exactly as a producer's relay would. */
export function delivery(options: DeliveryOptions): Delivery {
  const envelope = makeEvent({
    topic: options.topic,
    key: options.key,
    actor: options.actor ?? 'system',
    payload: options.payload ?? {},
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
    ...(options.id ? { id: options.id } : {}),
  })
  const body = serialiseEvent(envelope)
  return {
    body,
    signature: signDelivery(body, options.secret ?? SECRET, options.signedAt ?? Date.now()),
    envelope,
  }
}

/**
 * An event on a topic this build's registry has never heard of.
 *
 * Hand-built rather than through `makeEvent`, which by design refuses an unregistered topic — the
 * situation being reproduced is a producer that is *ahead* of this consumer's copy of
 * contracts-events, which is a normal consequence of deploying twenty-two services separately.
 */
export function unknownTopicDelivery(
  topic = 'worlds.session.ended',
  payload: Record<string, unknown> = { userId: ALICE },
): Delivery {
  const envelope = {
    id: eventId(),
    topic,
    key: ALICE,
    occurredAt: new Date().toISOString(),
    producer: 'worlds',
    version: '1.0',
    actor: 'system',
    correlationId: 'req-from-the-future',
    payload,
  }
  const body = JSON.stringify(envelope)
  return { body, signature: signDelivery(body, SECRET), envelope: envelope as unknown as EventEnvelope }
}
