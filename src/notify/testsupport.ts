/**
 * Shared setup for the tests. Not a test file itself: no `test()` call, excluded from the build.
 *
 * **A database test runs only against a database whose name says it is a test database.** That is
 * not a convenience: `resetNotify` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment.
 *
 * **No test in this repository sends anything.** Every channel is exercised through
 * `recordingAdapter`, and the email adapter's only test constructs it with no transport at all.
 * There is no mail server, no push gateway and no SMS provider in the suite, and the fake
 * webhook receiver is a function — nothing opens a socket to anything but Postgres.
 */

import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { eventId, makeEvent, type Actor, type TopicName } from '@cloudsforge/contracts-events'
import { ALL_TABLES, MIGRATIONS } from './migrations.ts'
import { registerServiceMetrics } from './metrics.ts'
import type { InboundEvent } from './events.ts'
import type { PipelineDeps } from './pipeline.ts'
import { registryOf, recordingAdapter, type ChannelAdapter, type RecordingAdapter } from './channels.ts'
import type { Channel } from './model.ts'

const url = process.env['NOTIFY_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set NOTIFY_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the CHECK constraints — above all the two that encode §10.3 — drift away from the
 * tests that are supposed to prove they hold.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'notify-test' })
}

export async function resetNotify(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${ALL_TABLES.join(', ')} restart identity cascade`)
}

/* ------------------------------------------------------------------ fixtures */

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'

/** Quiet by default: a passing suite that prints a hundred log lines hides the one that matters. */
export function testLogger(): Logger {
  return new Logger({ service: 'notify-test', level: 'error', version: 'test', env: 'test' })
}

/**
 * The same registry the composition root builds, HTTP and job metrics included.
 *
 * Registering only the domain metrics would make `metrics.increment('http_requests_total', …)` a
 * silent no-op — `Metrics` ignores an unregistered name — and a route test asserting on the RED
 * series would pass against a service that records none of them.
 */
export function testMetrics(): Metrics {
  return registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
}

/**
 * Read one counter series back out of the Prometheus text.
 *
 * Asserting on rendered output rather than on an internal map is deliberate: the thing that has
 * to be right is what a scrape sees, and a metric that increments a private counter but renders
 * nothing is the failure mode this catches.
 */
export function counterValue(
  metrics: Metrics,
  name: string,
  labels: Record<string, string> = {},
): number {
  const wanted = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',')
  for (const line of metrics.render().split('\n')) {
    if (!line.startsWith(name)) continue
    if (line.startsWith('#')) continue
    const open = line.indexOf('{')
    const close = line.lastIndexOf('}')
    const series = open >= 0 && close > open ? line.slice(open + 1, close) : ''
    if (series !== wanted) continue
    const value = Number(line.slice(line.lastIndexOf(' ') + 1))
    return Number.isNaN(value) ? 0 : value
  }
  return 0
}

/* ------------------------------------------------------------------ events */

/**
 * A valid envelope for a **registered** topic, built by the shared package.
 *
 * `makeEvent` rather than an object literal, so a test event is exactly what a real producer
 * emits — including the fields this service does not read. A hand-built fixture is how a consumer
 * test passes against a shape no producer ever sends.
 */
export function registeredEvent(
  topic: TopicName,
  key: string,
  payload: Record<string, unknown>,
  options: { readonly actor?: Actor; readonly id?: string; readonly occurredAt?: string } = {},
): InboundEvent {
  return makeEvent({
    topic,
    key,
    actor: options.actor ?? 'system',
    payload,
    ...(options.id ? { id: options.id } : {}),
    ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
  }) as InboundEvent
}

/**
 * An envelope for a topic the registry has not minted yet.
 *
 * `makeEvent` refuses these — correctly, since it takes `producer` and `version` from the
 * registry. This is the only place in the repository that assembles an envelope by hand, and it
 * exists solely because AD-08 names notifications for events whose producing services are not
 * written. It mirrors the package's field list exactly; `events.test.ts` pins the behaviour that
 * depends on it.
 */
export function unregisteredEvent(
  topic: string,
  key: string,
  payload: Record<string, unknown>,
  options: { readonly actor?: Actor; readonly id?: string; readonly producer?: string } = {},
): InboundEvent {
  const id = options.id ?? eventId()
  return {
    id,
    topic,
    key,
    occurredAt: new Date().toISOString(),
    producer: (options.producer ?? topic.split('.')[0] ?? 'identity') as InboundEvent['producer'],
    version: '1.0',
    actor: options.actor ?? 'system',
    correlationId: id,
    payload,
  }
}

/* ------------------------------------------------------------------ pipeline */

export interface TestRig {
  readonly deps: PipelineDeps
  readonly adapters: Record<Channel, RecordingAdapter>
  readonly metrics: Metrics
}

/**
 * A pipeline wired entirely to recording adapters.
 *
 * Every channel, including in-app and webhook, so a test can assert on what each one was asked to
 * send without any of them being able to reach the network. `backoff` is fixed rather than
 * jittered so a retry test can assert the next attempt time instead of tolerating a range.
 */
export function testRig(
  sql: postgres.Sql,
  options: {
    readonly now?: () => Date
    readonly maxAttempts?: number
    readonly backoffMs?: number
    readonly override?: Partial<Record<Channel, ChannelAdapter>>
    /**
     * Defaults to true, because the rig registers a working email adapter and a fixture should not
     * quietly describe a deployment nobody runs. A test that wants the SMTP-less mode — a supported
     * one, and the one in which a missing address must NOT be counted — says so.
     */
    readonly emailConfigured?: boolean
  } = {},
): TestRig {
  const recorders: Record<Channel, RecordingAdapter> = {
    in_app: recordingAdapter('in_app'),
    email: recordingAdapter('email'),
    web_push: recordingAdapter('web_push'),
    mobile_push: recordingAdapter('mobile_push'),
    sms: recordingAdapter('sms'),
    webhook: recordingAdapter('webhook'),
  }
  const adapters = registryOf(
    (Object.keys(recorders) as Channel[]).map(
      (channel) => options.override?.[channel] ?? recorders[channel],
    ),
  )
  const metrics = testMetrics()
  const backoffMs = options.backoffMs ?? 1_000
  return {
    metrics,
    adapters: recorders,
    deps: {
      sql,
      logger: testLogger(),
      metrics,
      adapters,
      publicUrl: 'https://app.cloudsforge.test',
      maxAttempts: options.maxAttempts ?? 6,
      instanceId: 'test-runner',
      emailConfigured: options.emailConfigured ?? true,
      backoff: () => backoffMs,
      leaseMs: 5_000,
      ...(options.now ? { now: options.now } : {}),
    },
  }
}
