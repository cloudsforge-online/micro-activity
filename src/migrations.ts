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

/** Rendered into the CHECK constraint, so the column and the TypeScript union cannot drift. */
const CATEGORY_LIST = STORED_CATEGORIES.map((category) => `'${category}'`).join(', ')
const VISIBILITY_LIST = VISIBILITIES.map((visibility) => `'${visibility}'`).join(', ')

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
