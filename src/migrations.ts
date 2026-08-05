/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied. The fix for a wrong migration is always a new one.
 *
 * ## Why there is an `inbox` but no `outbox`
 *
 * Activity is a pure consumer. AD-11 puts it downstream of every domain topic and it produces
 * none of its own — `contracts-events` registers no `activity.*` topic, so there is nothing this
 * service is entitled to publish. An outbox table here would come with a relay job, a signing
 * secret in the deploy and a permanently empty dashboard panel.
 *
 * The `inbox` is the opposite: it is the whole mechanism by which at-least-once delivery becomes
 * effectively-once handling, and 04-domain-model §10.6 specifies it as `(topic, event_id)`.
 *
 * ## Why the unique constraint on `source_event_id` as well
 *
 * They are not redundant and they are not two dedupes that can disagree, because they are written
 * in one transaction. The inbox row is the *handler-once* guard, generic and owned by §10.6. The
 * unique constraint is the *table invariant* from §10.1 — "source_event_id is unique, so a
 * redelivered event does not duplicate a feed entry" — and it is the one that still holds if a
 * future code path writes a record by some other route. A constraint that only exists in
 * application logic is a constraint that holds until the second caller.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'
import { STORED_CATEGORIES, VISIBILITIES } from './categories.ts'
import { RETENTION_CLASSES, RETENTION_DAYS, retentionClassSql } from './retention.ts'

/** Rendered into the CHECK constraint, so the column and the TypeScript union cannot drift. */
const CATEGORY_LIST = STORED_CATEGORIES.map((category) => `'${category}'`).join(', ')
const VISIBILITY_LIST = VISIBILITIES.map((visibility) => `'${visibility}'`).join(', ')
const RETENTION_LIST = RETENTION_CLASSES.map((name) => `'${name}'`).join(', ')

/**
 * The default periods, rendered into a SQL function so the view below can answer "what is overdue"
 * without asking a process. `env.ts` may only ever SHORTEN these — its maximum for each variable is
 * the same number — so what the schema reports as overdue is a subset of what the job deletes, on
 * every deployment, whatever its configuration.
 */
const RETENTION_CASE = RETENTION_CLASSES.map(
  (name) => `          when '${name}' then ${RETENTION_DAYS[name]}`,
).join('\n')

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs
    // table missing the (kind, key) unique constraint, which silently turns every recurring
    // enqueue into a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run — AD-10.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );

      -- The pruning job's access path.
      create index if not exists inbox_received_idx on inbox (received_at);
    `,
  },
  {
    version: 3,
    name: 'activity_records',
    up: `
      create table if not exists activity_records (
        id             uuid        primary key default gen_random_uuid(),
        -- Nullable, and deliberately so. A reconciliation run and a chain-level fault are domain
        -- events worth a permanent record and have no owner. A synthetic owner would put them in
        -- somebody's feed.
        user_id        uuid,
        -- When the fact happened, taken from the envelope. NOT when it was relayed or received:
        -- a feed ordered by arrival reorders itself whenever a producer retries.
        occurred_at    timestamptz not null,
        recorded_at    timestamptz not null default now(),
        category       text        not null,
        type           text        not null,
        subject_urn    text        not null,
        summary        text        not null,
        -- Text, not numeric. The producer's exact decimal is preserved: numeric(40,18) would
        -- return "10.000000000000000000" for a deposit of 10 and a feed that reformats a user's
        -- money is a feed they do not trust. The CHECK is what keeps it a number.
        amount         text,
        asset_code     text,
        correlation_id text        not null,
        -- §10.1: unique, so a redelivered event does not duplicate a feed entry.
        source_event_id uuid       not null,
        source_topic   text        not null,
        producer       text        not null,
        visibility     text        not null default 'user',
        -- Kept so an unclassified record can be reclassified later from data that was never
        -- thrown away. For a classified record it is the evidence behind the summary.
        payload        jsonb       not null default '{}'::jsonb,
        constraint activity_records_source_uniq unique (source_event_id),
        constraint activity_records_category check (category in (${CATEGORY_LIST})),
        constraint activity_records_visibility check (visibility in (${VISIBILITY_LIST})),
        constraint activity_records_amount check (amount is null or amount ~ '^-?[0-9]+(\\.[0-9]+)?$')
      );

      -- The feed. Keyset pagination orders by (occurred_at desc, id desc) and every filter is a
      -- prefix of one of these, so a page is an index scan rather than a sort of the user's whole
      -- history.
      create index if not exists activity_records_feed_idx
        on activity_records (user_id, occurred_at desc, id desc);

      create index if not exists activity_records_category_idx
        on activity_records (user_id, category, occurred_at desc, id desc);

      create index if not exists activity_records_producer_idx
        on activity_records (user_id, producer, occurred_at desc, id desc);

      -- The operator feed, and the query that finds the quarantine backlog.
      create index if not exists activity_records_internal_idx
        on activity_records (occurred_at desc, id desc);

      -- §10.1: immutable. Not "we do not update it" — the database refuses.
      --
      -- A feed entry that can be edited after the fact is not a record of what happened, it is a
      -- record of what somebody last said happened, and the two are indistinguishable afterwards.
      -- DELETE is deliberately still allowed: erasure under identity.user.deleted removes the row
      -- entirely, which is a different claim from rewriting it to say something else.
      create or replace function activity_records_no_update() returns trigger as $$
      begin
        raise exception 'activity_records is immutable; a correction is a new record';
      end;
      $$ language plpgsql;

      drop trigger if exists activity_records_immutable on activity_records;
      create trigger activity_records_immutable
        before update on activity_records
        for each row execute function activity_records_no_update();
    `,
  },
  {
    version: 4,
    name: 'retention',
    /**
     * STORAGE LIMITATION, PUT IN THE SCHEMA RATHER THAN IN A HANDLER.
     *
     * `src/retention.ts` holds the four periods and the basis for each; this migration is the half
     * of it that survives the application being wrong. The distinction that matters: a period
     * enforced only by a job stops existing the moment the job breaks, and it breaks silently,
     * whereas a column the database fills in itself is a column every row has.
     *
     * Postgres cannot delete rows on a schedule of its own, so this does not pretend to. What it
     * guarantees is everything up to the deletion:
     *
     *   * every row carries a `retention_class`, because a BEFORE INSERT trigger assigns it — an
     *     application that forgot, or a future writer that never knew, cannot produce a row without
     *     one;
     *   * it is NOT NULL and CHECK-constrained to the four names, so it cannot hold a fifth;
     *   * it cannot be edited afterwards, because migration 3's immutability trigger already
     *     refuses every UPDATE on this table;
     *   * and "which rows are overdue" is answerable by one query — `activity_records_retention` —
     *     on a morning when nothing has run for a month. `index.ts` scrapes that view into
     *     `activity_retention_overdue_total`, which is the alarm for the job having died.
     *
     * The trigger is the authority for the mapping and `retentionClassFor` in TypeScript is the
     * same rules for a reader; the CASE below is rendered from the very lists that function uses,
     * so the two cannot drift, and a test pins them against each other row by row anyway.
     *
     * DELETE stays allowed on this table, as migration 3 says at length. This migration adds the
     * second lawful reason to use it — expiry — alongside erasure, and takes nothing away.
     */
    up: `
      alter table activity_records
        add column if not exists retention_class text;

      -- Existing rows, classified by the same rules the trigger applies. A backfill rather than a
      -- default, because the class is a function of the row and 'personal' for everything would be
      -- wrong for exactly the records where it matters most.
      --
      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- THE IMMUTABILITY TRIGGER REFUSES THIS UPDATE, AND THAT IS WHY IT IS DISABLED AROUND IT.
      --
      -- Migration 3 installed a BEFORE UPDATE trigger that raises on every update to this table,
      -- deliberately: "a feed entry that can be edited after the fact is not a record of what
      -- happened". A backfill is an update. So without these two statements this migration runs
      -- perfectly against an empty database — there is nothing to update — and fails against every
      -- database that has ever recorded anything, which is all of them in production. It is the
      -- textbook migration that passes CI and breaks the deploy, and it was found by a test that
      -- inserts four rows before running this text rather than by the one that ran it on a fresh
      -- schema.
      --
      -- Safe, and not merely convenient. ALTER TABLE ... DISABLE TRIGGER takes an ACCESS
      -- EXCLUSIVE lock held until commit, and @cloudsforge/db runs each migration inside a
      -- transaction, so there is no window in which another session can update a row while the
      -- guard is off — the guard is off only for a transaction nothing else can write through.
      -- The immutability rule is suspended for one statement, by one migration, to fill a column
      -- that did not exist when the rows were written; it is not being relaxed.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      alter table activity_records disable trigger activity_records_immutable;

      update activity_records
         set retention_class = ${retentionClassSql()}
       where retention_class is null;

      alter table activity_records enable trigger activity_records_immutable;

      -- The trigger, before NOT NULL, so it is already filling the column when the constraint
      -- starts being enforced.
      create or replace function activity_records_retention() returns trigger as $$
      begin
        -- Assigned, never accepted. A caller that supplied a class would be choosing its own
        -- retention period, which is the whole thing this column exists to take away from it.
        new.retention_class := ${retentionClassSql('new.category', 'new.visibility')};
        return new;
      end;
      $$ language plpgsql;

      drop trigger if exists activity_records_set_retention on activity_records;
      create trigger activity_records_set_retention
        before insert on activity_records
        for each row execute function activity_records_retention();

      alter table activity_records
        alter column retention_class set not null;

      alter table activity_records
        drop constraint if exists activity_records_retention_class;
      alter table activity_records
        add constraint activity_records_retention_class
        check (retention_class in (${RETENTION_LIST}));

      -- The prune job's access path, and the view's. Leading with the class makes each class's
      -- sweep a range scan over one slice rather than a scan of the whole table per run.
      create index if not exists activity_records_retention_idx
        on activity_records (retention_class, recorded_at);

      -- The schema's own copy of the periods. IMMUTABLE so the view can use it freely; the numbers
      -- are the MAXIMA \`env.ts\` accepts, so this is an upper bound on every deployment.
      create or replace function activity_retention_days(class_name text) returns integer as $$
        select case class_name
${RETENTION_CASE}
        end;
      $$ language sql immutable;

      -- What an operator reads, and what the metric is scraped from. Deliberately a view and not a
      -- job's log line: it answers on a day the job has not run, which is the day the question is
      -- worth asking.
      --
      -- \`recorded_at\`, never \`occurred_at\`: storage limitation is about how long THIS service has
      -- held the data, and \`occurred_at\` is a producer-supplied value that a clock skew or a
      -- backfill would move in either direction. See the header of src/retention.ts.
      create or replace view activity_records_retention as
        select retention_class,
               activity_retention_days(retention_class) as retention_days,
               count(*)::bigint as records,
               min(recorded_at) as oldest,
               count(*) filter (
                 where recorded_at < now() - make_interval(days => activity_retention_days(retention_class))
               )::bigint as overdue
          from activity_records
         group by retention_class;
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * A new service baselines nothing. A non-zero baseline records migrations as applied without
 * running them, which is a one-way bridge for adopting an existing hand-built schema and has no
 * meaning for a database that has never existed.
 */
export const BASELINE_VERSION = 0
