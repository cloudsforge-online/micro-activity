/**
 * Storage limitation: the periods, the class every row is assigned, and the job that deletes.
 *
 * The test that carries the most weight is `THE RULE: the prune job actually deletes`, and it is
 * written the long way round — through a real `JobQueue` and a real `JobRunner`, claiming a real
 * leased row — rather than by calling the handler as a function. A retention period that nothing
 * executes is the defect this whole file exists to close, and a suite that invoked the handler
 * directly would pass just as happily against a service that never registered it, never enqueued
 * it, and never ran it. That is the same test-the-seam rule the estate applies to its bus.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { CATEGORIES, STORED_CATEGORIES, VISIBILITIES } from './categories.ts'
import { MIGRATIONS } from './migrations.ts'
import {
  FINANCIAL_CATEGORIES,
  PERSONAL_CATEGORIES,
  RETENTION_CLASSES,
  RETENTION_DAYS,
  retentionClassFor,
} from './retention.ts'
import { RECORD_PRUNE_KIND, RECURRING, registerHandlers, seedRecurring } from './jobs.ts'
import {
  ALICE,
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetActivity,
  skip,
  testMetrics,
} from './testsupport.ts'
import { retentionSummary, type Db } from './records.ts'

let sql: postgres.Sql
const db = () => sql as unknown as Db

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetActivity(sql)
})

/* ------------------------------------------------------------------ the periods */

test('THE RULE: every one of the sixteen categories is placed in exactly one retention class', () => {
  // Declared as two explicit lists rather than as "financial and the rest", so a seventeenth
  // category has to be placed by a person. This is the assertion that makes that true: it fails on
  // the day the category is added, not on the day somebody notices it has been kept for two years
  // under a basis nobody chose for it.
  const placed = [...FINANCIAL_CATEGORIES, ...PERSONAL_CATEGORIES].sort()
  assert.deepEqual(placed, [...CATEGORIES].sort())
  assert.equal(new Set(placed).size, CATEGORIES.length, 'a category is in both lists')
})

/* ------------------------------------------------------------------ the schema's copy */

test('THE RULE: the database assigns the retention class, and agrees with retention.ts row for row', { skip }, async () => {
  // Two implementations of one rule — a plpgsql trigger and a TypeScript function — and the whole
  // point of the schema copy is that it holds when the application is wrong. So they are pinned
  // against each other across the full cross product rather than on a couple of examples.
  let checked = 0
  for (const category of STORED_CATEGORIES) {
    for (const visibility of VISIBILITIES) {
      const rows = await sql<{ retention_class: string }[]>`
        insert into activity_records (
          user_id, occurred_at, category, type, subject_urn, summary, amount, asset_code,
          correlation_id, source_event_id, source_topic, producer, visibility, payload,
          -- Supplied deliberately, and deliberately ignored: the trigger ASSIGNS the class rather
          -- than accepting one, because a caller that chose its own would be choosing its own
          -- retention period. 'personal' is the shortest lie available for a financial row.
          retention_class
        ) values (
          null, now(), ${category}, 'x.y', 'urn:cloudsforge:wallet:x:1', 's', null, null,
          'c', gen_random_uuid(), 't', 'wallet', ${visibility}, '{}'::jsonb, 'personal'
        )
        returning retention_class
      `
      assert.equal(
        rows[0]?.retention_class,
        retentionClassFor(category, visibility),
        `${category}/${visibility} disagreed`,
      )
      checked += 1
    }
  }
  assert.equal(checked, STORED_CATEGORIES.length * VISIBILITIES.length)
  assert.equal(checked, 34)
})

test('THE RULE: the schema refuses a row with no retention class, and a class outside the four', { skip }, async () => {
  // NOT NULL plus a CHECK, so the obligation cannot be dropped by a writer that never knew about
  // it. The trigger fills the column, so the only way to reach the NOT NULL is to remove the
  // trigger — which is what a future migration doing this wrong would look like.
  await sql`alter table activity_records disable trigger activity_records_set_retention`
  try {
    await assert.rejects(
      () => sql`
        insert into activity_records (
          occurred_at, category, type, subject_urn, summary, correlation_id,
          source_event_id, source_topic, producer, visibility
        ) values (
          now(), 'deposit', 'x.y', 'urn:cloudsforge:wallet:x:1', 's', 'c',
          gen_random_uuid(), 't', 'wallet', 'user'
        )
      `,
      /retention_class/,
    )
    await assert.rejects(
      () => sql`
        insert into activity_records (
          occurred_at, category, type, subject_urn, summary, correlation_id,
          source_event_id, source_topic, producer, visibility, retention_class
        ) values (
          now(), 'deposit', 'x.y', 'urn:cloudsforge:wallet:x:1', 's', 'c',
          gen_random_uuid(), 't', 'wallet', 'user', 'for_ever'
        )
      `,
      /activity_records_retention_class/,
    )
  } finally {
    await sql`alter table activity_records enable trigger activity_records_set_retention`
  }
})

test('migration 4 backfills a table that already has rows, not only an empty one', { skip }, async () => {
  // The deploy this actually happens on is an existing database with several months of records in
  // it. A migration that only works from empty is one that fails the first time it matters, so the
  // v3 shape is reconstructed here — rows and all — and migration 4's own text is re-run over it.
  await insertRecord({ category: 'deposit', visibility: 'user', ageDays: 1 })
  await insertRecord({ category: 'unclassified', visibility: 'internal', ageDays: 1 })
  await insertRecord({ category: 'community', visibility: 'internal', ageDays: 1 })
  await insertRecord({ category: 'security', visibility: 'user', ageDays: 1 })

  const retention = MIGRATIONS.find((migration) => migration.version === 4)
  assert.ok(retention, 'migration 4 is the retention migration')

  /**
   * All of it inside one transaction that is rolled back at the end.
   *
   * DDL is transactional in Postgres, and this test has to take the schema apart to rebuild it. An
   * earlier draft did that with bare statements, failed halfway, and left the shared test database
   * without its trigger — after which every other case in this file failed for a reason that had
   * nothing to do with what it was testing. A test that can corrupt the fixture on its way to
   * failing is a test that hides the next bug.
   */
  class Rollback extends Error {}
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        // Back to the shape a v3 database has: no view, no trigger, no column — rows still there.
        await tx`drop view if exists activity_records_retention`
        await tx`drop trigger if exists activity_records_set_retention on activity_records`
        await tx`alter table activity_records drop constraint if exists activity_records_retention_class`
        await tx`alter table activity_records drop column retention_class`
        const before = await tx<{ n: number }[]>`select count(*)::int as n from activity_records`
        assert.equal(before[0]?.n, 4, 'the rows must still be there, or this proves nothing')

        await tx.unsafe(retention.up)

        const rows = await tx<{ category: string; retention_class: string }[]>`
          select category, retention_class from activity_records order by category
        `
        // Every pre-existing row classified by the same rules the trigger applies — and not one of
        // them defaulted to 'personal', which is the shortest lie available for a financial row.
        assert.deepEqual(
          rows.map((row) => [row.category, row.retention_class]),
          [
            ['community', 'operational'],
            ['deposit', 'financial'],
            ['security', 'personal'],
            ['unclassified', 'quarantine'],
          ],
        )
        throw new Rollback('asserted; now put the schema back')
      }),
    Rollback,
  )

  // The fixture is intact, so the cases after this one are testing what they say they are.
  const restored = await sql<{ retention_class: string }[]>`
    select retention_class from activity_records limit 1
  `
  assert.ok(restored[0]?.retention_class)
})

/* ------------------------------------------------------------------ the job */

interface Fixture {
  readonly category: string
  readonly visibility: string
  readonly ageDays: number
}

/**
 * One row, aged.
 *
 * `recorded_at` is set explicitly, which is the only way to write a row that is already expired —
 * and `recorded_at` rather than `occurred_at` is the whole of what the job measures. Raw SQL rather
 * than `insertRecord`, because the age is the fixture and `insertRecord` correctly refuses to let a
 * caller choose it.
 */
async function insertRecord(fixture: Fixture): Promise<void> {
  await sql`
    insert into activity_records (
      user_id, occurred_at, recorded_at, category, type, subject_urn, summary,
      correlation_id, source_event_id, source_topic, producer, visibility, payload
    ) values (
      ${ALICE}, now(), now() - make_interval(days => ${fixture.ageDays}),
      ${fixture.category}, 'x.y', 'urn:cloudsforge:wallet:x:1', 's',
      'c', gen_random_uuid(), 't', 'wallet', ${fixture.visibility}, '{}'::jsonb
    )
  `
}

async function classesLeft(): Promise<string[]> {
  const rows = await sql<{ retention_class: string }[]>`
    select retention_class from activity_records order by retention_class
  `
  return rows.map((row) => row.retention_class)
}

test('THE RULE: the prune job actually deletes, and only what is past its own period', { skip }, async () => {
  // Eight rows: one just inside each class's period and one just outside it. A job that deleted
  // everything would pass a test that only checked the expired rows were gone, and a job that
  // deleted nothing would pass a test that only checked the fresh ones survived.
  for (const [retentionClass, fixture] of [
    ['quarantine', { category: 'unclassified', visibility: 'internal' }],
    ['financial', { category: 'deposit', visibility: 'user' }],
    ['operational', { category: 'community', visibility: 'internal' }],
    ['personal', { category: 'security', visibility: 'user' }],
  ] as const) {
    const days = RETENTION_DAYS[retentionClass]
    await insertRecord({ ...fixture, ageDays: days - 1 })
    await insertRecord({ ...fixture, ageDays: days + 1 })
  }
  assert.equal((await classesLeft()).length, 8)

  const metrics = testMetrics()
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'retention-test' })
  const completed: string[] = []
  const runner = new JobRunner({
    queue,
    pollMs: 20,
    onEvent: (event) => {
      if (event.type === 'completed' && event.kind) completed.push(event.kind)
    },
  })
  registerHandlers(runner, {
    sql: db(),
    logger: quietLogger(),
    metrics,
    inboxRetentionDays: 30,
    retentionDays: RETENTION_DAYS,
  })

  // Seeded, not enqueued by hand. `seedRecurring` is what `index.ts` calls at boot, so this asserts
  // the job is in the recurring set as well as that its handler works — a handler registered for a
  // kind nothing ever enqueues is the silent half of "the job does not run".
  await seedRecurring(queue)
  assert.ok(
    RECURRING.some((job) => job.kind === RECORD_PRUNE_KIND),
    'the prune must be a recurring job, not something a person remembers to run',
  )

  runner.start()
  try {
    const deadline = Date.now() + 10_000
    while (!completed.includes(RECORD_PRUNE_KIND) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    await runner.stop(5_000)
  }
  assert.ok(completed.includes(RECORD_PRUNE_KIND), 'the prune job never ran')

  // One of each left: the row inside its period. Four gone: the row outside it.
  assert.deepEqual(await classesLeft(), ['financial', 'operational', 'personal', 'quarantine'])

  // And it is observable as having run, per class, without reading a log line.
  const rendered = metrics.render()
  for (const retentionClass of RETENTION_CLASSES) {
    assert.match(
      rendered,
      new RegExp(`activity_records_pruned_total\\{class="${retentionClass}"\\} 1`),
      `${retentionClass} did not report a deletion`,
    )
  }
})

test('the retention view answers on a day the job has not run, which is the day it matters', { skip }, async () => {
  // The gauge `index.ts` scrapes. It is computed from the table rather than from anything the job
  // reports, because a job that has stopped running reports nothing at all — and "nothing" and
  // "nothing to do" are the two states this number exists to tell apart.
  await insertRecord({ category: 'deposit', visibility: 'user', ageDays: 1 })
  await insertRecord({ category: 'unclassified', visibility: 'internal', ageDays: RETENTION_DAYS.quarantine + 5 })

  // Through `retentionSummary`, which is the function `index.ts` scrapes with. A query written
  // inline in the composition root is a query no suite can reach, and a misspelled column there is
  // a /metrics endpoint that 500s in production against a green build.
  assert.deepEqual(await retentionSummary(db()), [
    { retentionClass: 'financial', retentionDays: RETENTION_DAYS.financial, records: 1, overdue: 0 },
    { retentionClass: 'quarantine', retentionDays: RETENTION_DAYS.quarantine, records: 1, overdue: 1 },
  ])
})
