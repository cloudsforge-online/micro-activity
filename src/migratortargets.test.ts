/**
 * Two modules, two migration ledgers, and the check that keeps them from becoming one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FAILURE THIS GUARDS IS NOT A CRASH.**
 *
 * `@cloudsforge/db` records applied migrations in a table called `schema_migrations`. The name is a
 * literal in that package and takes no option, so two modules migrating ONE database write into one
 * ledger keyed by `version` — and both modules number their migrations from 1.
 *
 * Whichever runs first records versions 1..N; the second then finds those rows, treats its OWN
 * 1..N as already applied, creates none of its tables, and the migrator exits 0. The deploy goes
 * green. The service refuses to serve at the next boot's schema assertion, naming a version rather
 * than the cause.
 *
 * Nothing downstream catches it. The advisory locks are derived from the SERVICE name and the two
 * names differ, so the two runs do not even serialise against each other.
 *
 * And it matters more for this pair than it did for wave M1's. lantern and analytics both owned a
 * table called `events` — with DIFFERENT columns, so a shared database would at least have failed
 * on conflicting DDL. activity and notify both own a table called `inbox` with IDENTICAL columns,
 * and both own a `jobs`. `the two schemas really do collide` below measures that rather than
 * asserting it from memory, because the whole argument for this check rests on it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MIGRATIONS as ACTIVITY_MIGRATIONS } from './migrations.ts'
import { ALL_TABLES as NOTIFY_TABLES, MIGRATIONS as NOTIFY_MIGRATIONS } from './notify/migrations.ts'
import { addresses, assertDistinct, type Target } from './migratortargets.ts'

const activity = (url: string): Target => ({
  module: 'activity',
  network: 'primary',
  url,
  migrations: [],
  baselineVersion: 0,
})

const notify = (url: string): Target => ({
  module: 'notify',
  network: 'primary',
  url,
  migrations: [],
  baselineVersion: 0,
})

describe('what a DSN addresses', () => {
  it('is host, port and database — and never the credentials', () => {
    // The credentials are dropped for two reasons at once. Two DSNs differing only in the user they
    // connect as still address ONE ledger, so keeping them would make the check miss the case it
    // exists for. And dropping them is what makes the return value safe to put in the error message
    // below, which is a message an operator reads in a deploy log.
    const addressed = addresses('postgres://someone:something@db.internal:6432/activity')
    assert.equal(addressed, 'db.internal:6432/activity')
    assert.ok(!addressed.includes('someone'))
    assert.ok(!addressed.includes('something'))
  })

  it('defaults the port, so the same database written two ways is one address', () => {
    assert.equal(
      addresses('postgres://u:p@db.internal/activity'),
      addresses('postgres://u:p@db.internal:5432/activity'),
    )
  })

  it('is case-folded on host and database, because Postgres is', () => {
    assert.equal(addresses('postgres://u:p@DB.Internal:5432/Activity'), 'db.internal:5432/activity')
  })

  it('degrades to "cannot prove these are the same" rather than refusing a DSN it cannot parse', () => {
    // postgres.js accepts shapes `URL` does not. Refusing here would break a working deployment to
    // enforce a check; answering '' says honestly that this one cannot be compared, and the
    // migration itself still fails loudly if it is wrong.
    assert.equal(addresses('not a url'), '')
  })
})

describe('two modules may not point at one database', () => {
  it('refuses the pair, before a statement is issued', () => {
    assert.throws(
      () => assertDistinct([activity('postgres://u:p@db:5432/one'), notify('postgres://u:p@db:5432/one')]),
      (err: Error) => {
        // The message has to carry the diagnosis, because the symptom it prevents appears at the
        // NEXT deploy's boot, in a different process, as a version number.
        assert.match(err.message, /activity\/primary and notify\/primary/)
        assert.match(err.message, /schema_migrations/)
        assert.match(err.message, /silently skipped/)
        assert.ok(!err.message.includes('u:p'), 'the refusal must not print the credentials')
        return true
      },
    )
  })

  it('refuses it however the two DSNs are spelled', () => {
    // Different user, default port written out, different case: still one database.
    assert.throws(() =>
      assertDistinct([
        activity('postgres://reader:x@DB:5432/shared'),
        notify('postgres://writer:y@db/Shared'),
      ]),
    )
  })

  it('refuses ONE module pointed twice at one database too', () => {
    // The mainnet and testnet DSNs being identical. Migrating one database twice under one ledger
    // is at best a no-op nobody asked for and at worst two networks' rows in one place, which is
    // the failure the whole network split exists to prevent.
    assert.throws(() =>
      assertDistinct([
        { ...activity('postgres://u:p@db:5432/one'), network: 'primary' },
        { ...activity('postgres://u:p@db:5432/one'), network: 'testnet' },
      ]),
    )
  })

  it('allows the arrangement a real deployment has', () => {
    // activity: one database per network. notify: one database, network on the column. Asymmetric
    // by design — see `notify/module.ts`'s selector — and the check must not read that as a fault.
    assertDistinct([
      { ...activity('postgres://u:p@db:5432/activity'), network: 'primary' },
      { ...activity('postgres://u:p@db:5432/activity_testnet'), network: 'testnet' },
      notify('postgres://u:p@db:5432/notify'),
    ])
  })

  it('does not compare what it cannot parse', () => {
    // Two unparseable DSNs are not evidence of anything, and treating them as equal would refuse a
    // deployment for a reason that is not a fault.
    assertDistinct([activity('not a url'), notify('also not a url')])
  })
})

describe('the two schemas really do collide, which is why the check is not theoretical', () => {
  it('both modules own a table called `inbox` and a table called `jobs`', () => {
    const activityTables = tablesCreatedBy(ACTIVITY_MIGRATIONS)
    const notifyTables = tablesCreatedBy(NOTIFY_MIGRATIONS)

    for (const shared of ['inbox', 'jobs']) {
      assert.ok(activityTables.has(shared), `activity must still create ${shared}`)
      assert.ok(notifyTables.has(shared), `notify must still create ${shared}`)
    }
    // And notify's own truncation list names `inbox` too, which is the second reason the two
    // databases must be separate: one shared database would have one suite emptying the other's
    // dedupe table mid-test — a flake, not a legible configuration error.
    assert.ok(NOTIFY_TABLES.includes('inbox'))
    assert.ok(NOTIFY_TABLES.includes('jobs'))
  })

  it('and the two `inbox` tables have the SAME columns, so a wrong handle is silent', () => {
    /*
     * The sharpest edge in this wave, and the reason `RouteSpec.sql` is load-bearing rather than
     * tidy. In wave M1 the two `events` tables had different columns, so a route handed the wrong
     * module's database answered 500. Here it answers 2xx: the insert lands in the other module's
     * dedupe table and the next genuine delivery of that event is reported as a "duplicate".
     */
    const columns = (migrations: readonly { up: string }[]): readonly string[] => {
      const create = /create table if not exists inbox \(([\s\S]*?)\);/.exec(
        migrations.map((m) => m.up).join('\n'),
      )
      assert.notEqual(create, null, 'the inbox DDL is what this reads; it has moved or been renamed')
      return (create?.[1] ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0] ?? '')
        .filter((name) => /^[a-z_]+$/.test(name) && name !== 'primary')
        .sort()
    }
    const activityColumns = columns(ACTIVITY_MIGRATIONS)
    assert.ok(activityColumns.length >= 3, `parsed only ${activityColumns.length} columns; the parser has rotted`)
    assert.deepEqual(
      activityColumns,
      columns(NOTIFY_MIGRATIONS),
      'if these ever diverge the wrong-handle failure becomes loud, and this test should be ' +
        'rewritten rather than deleted — but it is the identical shape that makes it silent today',
    )
  })

  it('and both number their migrations from 1, which is what one shared ledger would confuse', () => {
    assert.equal(Math.min(...ACTIVITY_MIGRATIONS.map((m) => m.version)), 1)
    assert.equal(Math.min(...NOTIFY_MIGRATIONS.map((m) => m.version)), 1)
  })
})

/** Table names a migration set creates. Enough for the collision measurement, and no more. */
function tablesCreatedBy(migrations: readonly { up: string }[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const migration of migrations) {
    for (const match of migration.up.matchAll(/create table (?:if not exists )?([a-z_]+)/g)) {
      names.add(match[1] as string)
    }
  }
  // `jobs` is created by `@cloudsforge/jobs`'s own DDL rather than by either module's migration
  // list in some services; both of these declare it themselves, and this asserts that is still so
  // rather than letting the case above pass on an empty set.
  assert.ok(names.size > 2, `parsed only ${names.size} tables; the DDL scan has rotted`)
  return names
}
