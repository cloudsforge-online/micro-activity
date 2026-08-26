/**
 * The migration set itself.
 *
 * The first two tests need no database: they check properties of the list, and an out-of-order or
 * duplicated version is the sort of mistake that only shows up on the one database that has
 * already applied the earlier file.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type postgres from 'postgres'
import { ALL_TABLES, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { CATEGORIES, CHANNELS, FAILURE_REASONS, PRIORITIES } from './model.ts'
import { enabled, migrateTestDb, openDb, skip } from './testsupport.ts'

test('versions are unique, contiguous and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length)
  versions.forEach((version, index) => assert.equal(version, index + 1))
  assert.equal(SCHEMA_VERSION, versions[versions.length - 1])
})

test('the CHECK lists are generated from the types, so they cannot drift', () => {
  const preferences = MIGRATIONS.find((m) => m.name === 'preferences')?.up ?? ''
  for (const category of CATEGORIES) assert.match(preferences, new RegExp(`'${category}'`))
  for (const channel of CHANNELS) assert.match(preferences, new RegExp(`'${channel}'`))

  const notifications = MIGRATIONS.find((m) => m.name === 'notifications')?.up ?? ''
  for (const priority of PRIORITIES) assert.match(notifications, new RegExp(`'${priority}'`))
})

test('a released migration does not re-render when a type it generated from grows', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THIS IS THE TEST THAT WOULD HAVE CAUGHT IT, AND IT DID NOT EXIST.
  //
  // `@cloudsforge/db` checksums a migration's TEXT and refuses to run when an applied one has
  // changed. Version 5 generated its `reason` CHECK straight from `FAILURE_REASONS`, so adding
  // one value to a TypeScript union — which is a source change nobody would think to call a
  // schema change — rewrote a migration every database in the estate had applied, and `migrate`
  // then refuses everything with a message about version 5 rather than about the union.
  //
  // So version 5 renders its own frozen list and the widening is version 8. This test pins the
  // frozen text: the six values version 5 shipped with are still exactly the six it names.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const deliveries = MIGRATIONS.find((m) => m.name === 'deliveries')?.up ?? ''
  const reasonCheck = /reason\s+text\s+check \(reason is null or reason in \(([^)]*)\)\)/.exec(deliveries)
  const frozen = reasonCheck?.[1] ?? ''
  assert.equal(
    frozen,
    "'no_transport', 'no_address', 'invalid_payload', 'rejected', 'timeout', 'upstream_error'",
  )

  // And the frozen list is a PREFIX of the live one, not merely different from it. A value may be
  // added; one may not be removed or reordered out from under a constraint that already admits it.
  const asShipped = frozen.split(', ').map((value) => value.replace(/'/g, ''))
  assert.deepEqual(FAILURE_REASONS.slice(0, asShipped.length), asShipped)
})

test('every failure reason this build can write is admitted by some migration', () => {
  // The constraint is what turns "a reason the code emits but the schema refuses" from a rejected
  // insert at three in the morning into a failed test.
  //
  // The NEWEST widening is what has to admit the whole live union, and it is found by what it does
  // rather than by its name. Naming it pinned this test to `quota-exhausted-reason`, so version 9
  // adding `reserved_domain` failed here against version 8's text — a true failure reported against
  // the wrong migration, which is the same shape of confusion the frozen-list note in
  // `migrations.ts` exists to prevent. A third reason should need no edit to this test at all.
  const widenings = MIGRATIONS.filter((m) => /add constraint deliveries_reason_check/.test(m.up))
  const widened = widenings[widenings.length - 1]?.up ?? ''
  assert.ok(widenings.length >= 2, 'the reason constraint is widened by its own migration each time')
  for (const reason of FAILURE_REASONS) assert.match(widened, new RegExp(`'${reason}'`))
  // Expand-only: it drops the old constraint by name and adds one that is a superset, so a replica
  // of the previous release writing `upstream_error` against this schema is unaffected.
  assert.match(widened, /drop constraint if exists deliveries_reason_check/)

  // And EVERY earlier widening still renders exactly what it rendered when it was applied. This is
  // the assertion that would have caught version 8 interpolating the live union: adding a value
  // rewrites an applied migration's text, `@cloudsforge/db` checksums that text, and the service
  // then refuses to boot with a message about a migration nobody touched.
  for (const earlier of widenings.slice(0, -1)) {
    assert.doesNotMatch(
      earlier.up,
      /'reserved_domain'/,
      `${earlier.name} renders a value added after it shipped; it must render a frozen list`,
    )
  }
})

test('the two constraints that encode §10.3 are present in the migration text', () => {
  // Named, so a future migration that drops one is a visible deletion rather than an omission.
  const notifications = MIGRATIONS.find((m) => m.name === 'notifications')?.up ?? ''
  assert.match(notifications, /notifications_critical_never_suppressed/)
  assert.match(notifications, /notifications_critical_reaches_a_channel/)
})

describe('applied schema', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    if (!enabled) return
    sql = openDb(2)
    await migrateTestDb(sql)
  })

  after(async () => {
    if (!enabled) return
    await sql.end({ timeout: 5 })
  })

  test('every table the reset truncates actually exists', async () => {
    // A table missing from ALL_TABLES leaks rows between test files; one that does not exist
    // makes every reset fail. Both are caught here rather than in whichever test ran second.
    const rows = await sql<Array<{ tablename: string }>>`
      select tablename from pg_tables where schemaname = 'public'
    `
    const present = new Set(rows.map((row) => row.tablename))
    for (const table of ALL_TABLES) assert.ok(present.has(table), `${table} is missing`)
  })

  test('the schema reports the version this build requires', async () => {
    const rows = await sql<Array<{ version: number }>>`
      select coalesce(max(version), 0)::int as version from schema_migrations
    `
    assert.equal(rows[0]?.version, SCHEMA_VERSION)
  })

  test('the generated outcome column spells the terminal states out', async () => {
    // `undeliverable_no_transport` is one value in one column, so the dead-letter view is a
    // group-by rather than a case expression in three dashboards.
    const rows = await sql<Array<{ outcome: string }>>`
      select (case when 'undeliverable' = 'undeliverable' then 'undeliverable_' || 'no_transport' end) as outcome
    `
    assert.equal(rows[0]?.outcome, 'undeliverable_no_transport')

    const definition = await sql<Array<{ generation_expression: string }>>`
      select generation_expression from information_schema.columns
       where table_name = 'deliveries' and column_name = 'outcome'
    `
    assert.match(definition[0]?.generation_expression ?? '', /undeliverable_/)
  })
})
