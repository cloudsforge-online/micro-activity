/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 3" means. The fix for a wrong migration is always a new migration.
 *
 * ## The two constraints to read before anything else
 *
 * On `notifications`:
 *
 *     check (priority <> 'critical' or suppressed_reason is null)
 *     check (priority <> 'critical' or channel_count >= 1)
 *
 * Those are 04-domain-model §10.3 written where it cannot be argued with. A critical notification
 * that was suppressed, or that reached no channel, has no representation in this database. Not
 * for this service, not for a future one sharing the schema, not for an operator with psql and a
 * good reason. `channel_count` defaults to zero, so the insert path is *forced* to compute the
 * routing before it writes the row — which is exactly the ordering the invariant needs.
 *
 * The CHECK value lists are generated from the arrays in `model.ts`, so the database and the
 * TypeScript union cannot drift apart. Adding a channel is one edit.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'
import {
  CATEGORIES,
  CHANNELS,
  DELIVERY_STATES,
  DIGESTS,
  FAILURE_REASONS,
  PRIORITIES,
  SUPPRESSION_REASONS,
  sqlValues,
} from './model.ts'

/**
 * The failure reasons as version 5 rendered them, frozen — **never edit this list**.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A GENERATED CHECK LIST IN A RELEASED MIGRATION IS A CHECKSUM THAT CHANGES WHEN A TYPE DOES.**
 *
 * Version 5 interpolated `sqlValues(FAILURE_REASONS)` directly. That is exactly the drift-proofing
 * this file's header argues for, and it has one consequence nobody had hit until 2026-08-09:
 * `@cloudsforge/db` checksums each migration's **text**, so adding one value to the TypeScript
 * union rewrites the text of a migration every database in the estate has already applied.
 * `migrate` then refuses to run at all — `migration 5 (deliveries) was modified after it was
 * applied` — and the service cannot boot. Not the reason it refuses to boot, either: it refuses on
 * a schema check with no mention of the union that moved.
 *
 * So version 5 renders this frozen copy, byte for byte what it rendered before, and every later
 * addition arrives as its own migration widening the constraint. The generation stays where it
 * still pays — a value cannot be spelled two ways — and `migrations.test.ts` asserts this list is
 * a prefix of the live one, so a reason can still be ADDED and cannot be quietly removed or
 * reordered underneath a released constraint.
 *
 * The same trap is loaded in every other generated CHECK here (`CATEGORIES`, `CHANNELS`,
 * `PRIORITIES`, `DIGESTS`, `SUPPRESSION_REASONS`, `DELIVERY_STATES`). They are left alone because
 * none of them has moved and a speculative freeze of six lists would be six chances to typo a
 * value into a checksum. When one of them moves, it takes this treatment.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const FAILURE_REASONS_AT_5: readonly string[] = [
  'no_transport',
  'no_address',
  'invalid_payload',
  'rejected',
  'timeout',
  'upstream_error',
]

/**
 * The failure reasons as version 8 rendered them, frozen — **never edit this list**.
 *
 * Version 8 was written to fix the version 5 trap and interpolated `sqlValues(FAILURE_REASONS)`
 * itself, which re-armed it one migration later: the next value added to the union would have
 * rewritten the text of a migration every database in the estate had already applied, and
 * `migrate` would have refused to boot the service with a message about version 8. Found on
 * 2026-08-11 while adding `reserved_domain`, before it fired.
 *
 * The values below are byte-identical to what version 8 rendered, so freezing them changes no
 * checksum. Every later addition arrives as its own migration, and `migrations.test.ts` asserts
 * this list is a prefix of the live one — so a reason can still be added, and cannot be quietly
 * removed or reordered underneath a released constraint.
 *
 * **The rule, stated once so the next person does not have to rediscover it twice: a migration
 * that renders a generated list must render a FROZEN copy of it.** Reaching for the live constant
 * is correct everywhere else in this file and wrong here.
 */
const FAILURE_REASONS_AT_8: readonly string[] = [...FAILURE_REASONS_AT_5, 'quota_exhausted']

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
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      -- AD-10. This service has no outbox: it owns no topic in the registry and produces no
      -- events, so an outbox table here would be a table nothing ever writes to.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 3,
    name: 'preferences',
    up: `
      create table if not exists preferences (
        user_id      uuid        not null,
        category     text        not null check (category in (${sqlValues(CATEGORIES)})),
        channel      text        not null check (channel in (${sqlValues(CHANNELS)})),
        enabled      boolean     not null default true,
        digest       text        not null default 'instant' check (digest in (${sqlValues(DIGESTS)})),
        min_priority text        not null default 'low' check (min_priority in (${sqlValues(PRIORITIES)})),
        updated_at   timestamptz not null default now(),
        primary key (user_id, category, channel)
      );

      -- Where a user is reachable. One row per address per channel.
      --
      -- The address column holds an email address, a push token, an E.164 number or a webhook
      -- endpoint URL depending on the channel — the "different addressing scheme" of AD-08, in
      -- one column rather than in a second table, because everything downstream of it is shared.
      create table if not exists channel_targets (
        id          uuid        primary key default gen_random_uuid(),
        user_id     uuid        not null,
        channel     text        not null check (channel in (${sqlValues(CHANNELS)})),
        address     text        not null,
        -- Shared HMAC secret, webhook endpoints only. Never logged, never returned by any route.
        secret      text,
        label       text,
        active      boolean     not null default true,
        verified_at timestamptz,
        created_at  timestamptz not null default now(),
        constraint channel_targets_uniq unique (user_id, channel, address),
        -- An in-app "target" would be a row describing the absence of an address. The floor
        -- channel is implicit everywhere, and a row for it would be a second source of truth.
        constraint channel_targets_not_in_app check (channel <> 'in_app'),
        -- A webhook without a secret cannot be signed, and an unsigned webhook must never be
        -- sent. Refusing the row is better than discovering it at delivery time.
        constraint channel_targets_webhook_signed
          check (channel <> 'webhook' or (secret is not null and length(secret) >= 16))
      );

      create index if not exists channel_targets_lookup_idx
        on channel_targets (user_id, channel)
        where active;
    `,
  },
  {
    version: 4,
    name: 'notifications',
    up: `
      create table if not exists notifications (
        id               uuid        primary key default gen_random_uuid(),
        user_id          uuid        not null,
        category         text        not null check (category in (${sqlValues(CATEGORIES)})),
        priority         text        not null check (priority in (${sqlValues(PRIORITIES)})),
        template_id      text        not null,
        params           jsonb       not null default '{}'::jsonb,
        locale           text        not null default 'en-GB',
        dedupe_key       text,
        subject_urn      text,
        source_topic     text,
        source_event_id  uuid,
        correlation_id   text,
        -- How many channels this notification was routed to. Written in the same statement as
        -- the row, from the routing decision, which is what makes the CHECK below meaningful.
        channel_count    integer     not null default 0,
        suppressed_reason text       check (suppressed_reason is null or suppressed_reason in (${sqlValues(SUPPRESSION_REASONS)})),
        created_at       timestamptz not null default now(),
        read_at          timestamptz,

        -- 04-domain-model §10.3, in the database. A user cannot opt out of being told their key
        -- left, and neither can a bug, a migration or an operator.
        constraint notifications_critical_never_suppressed
          check (priority <> 'critical' or suppressed_reason is null),
        constraint notifications_critical_reaches_a_channel
          check (priority <> 'critical' or channel_count >= 1)
      );

      -- Deduplication on dedupe_key, per user. Partial, so the many notifications that legitimately
      -- have no key do not contend for one index entry.
      create unique index if not exists notifications_dedupe_idx
        on notifications (user_id, dedupe_key)
        where dedupe_key is not null;

      -- The GET /notifications access path. (created_at desc, id desc) matches the keyset pager
      -- exactly, so the page after the cursor is an index range scan rather than an offset.
      create index if not exists notifications_user_idx
        on notifications (user_id, created_at desc, id desc);

      create index if not exists notifications_unread_idx
        on notifications (user_id)
        where read_at is null;
    `,
  },
  {
    version: 5,
    name: 'deliveries',
    up: `
      -- ONE delivery-history table, for every channel including developer webhooks. AD-08.
      create table if not exists deliveries (
        id              uuid        primary key default gen_random_uuid(),
        notification_id uuid        not null references notifications (id) on delete cascade,
        user_id         uuid        not null,
        channel         text        not null check (channel in (${sqlValues(CHANNELS)})),
        target_id       uuid        references channel_targets (id) on delete set null,
        state           text        not null default 'pending' check (state in (${sqlValues(DELIVERY_STATES)})),
        reason          text        check (reason is null or reason in (${sqlValues(FAILURE_REASONS_AT_5)})),
        attempts        integer     not null default 0,
        max_attempts    integer     not null default 6,
        next_attempt_at timestamptz not null default now(),
        -- The lease. Same shape as jobs.locked_by/locked_until and for the same reason: a second
        -- replica must not claim a delivery this one is mid-way through sending.
        leased_by       text,
        leased_until    timestamptz,
        last_error      text,
        provider_ref    text,
        created_at      timestamptz not null default now(),
        sent_at         timestamptz,

        -- The exact string an operator greps for. A state that has a reason spells them together
        -- so 'undeliverable_no_transport' is one value in one column rather than a join of two,
        -- and a dashboard panel is a group-by rather than a case expression.
        outcome         text generated always as (
                          case when state = 'undeliverable' then 'undeliverable_' || coalesce(reason, 'unknown')
                               when state = 'dead' then 'dead_' || coalesce(reason, 'unknown')
                               else state end
                        ) stored,

        constraint deliveries_sent_has_time check (state <> 'sent' or sent_at is not null),
        constraint deliveries_terminal_has_reason
          check (state not in ('undeliverable', 'dead') or reason is not null)
      );

      -- The dispatcher's access path. Partial on the claimable set, so the index stays the size
      -- of the backlog rather than the size of delivery history.
      create index if not exists deliveries_due_idx
        on deliveries (next_attempt_at)
        where state = 'pending';

      create index if not exists deliveries_notification_idx
        on deliveries (notification_id);

      -- The dead-letter view's access path: GET /admin/deliveries, newest first.
      create index if not exists deliveries_deadletter_idx
        on deliveries (created_at desc)
        where state in ('dead', 'undeliverable');
    `,
  },
  {
    version: 6,
    name: 'digests',
    up: `
      -- A digest is a batch that has not been sent yet. One open batch per (user, channel,
      -- cadence, window) — the unique constraint is what makes batching a batch rather than a
      -- race between two events arriving in the same second.
      create table if not exists digests (
        id            uuid        primary key default gen_random_uuid(),
        user_id       uuid        not null,
        channel       text        not null check (channel in (${sqlValues(CHANNELS)})),
        cadence       text        not null check (cadence in ('hourly', 'daily')),
        scheduled_for timestamptz not null,
        state         text        not null default 'open' check (state in ('open', 'flushed')),
        created_at    timestamptz not null default now(),
        flushed_at    timestamptz,
        constraint digests_window_uniq unique (user_id, channel, cadence, scheduled_for)
      );

      create table if not exists digest_entries (
        digest_id       uuid not null references digests (id) on delete cascade,
        notification_id uuid not null references notifications (id) on delete cascade,
        primary key (digest_id, notification_id)
      );

      create index if not exists digests_due_idx
        on digests (scheduled_for)
        where state = 'open';
    `,
  },
  {
    version: 7,
    name: 'broadcasts',
    up: `
      -- An operator broadcast, and the fan-out record for it.
      --
      -- Notify is not the user registry, so "everyone" means every user this service can reach:
      -- every distinct user_id with an active channel target or an existing preference. That is
      -- stated here rather than assumed, because the alternative — asking identity for a full
      -- user list — makes a broadcast fail when identity is having a bad minute, which is
      -- precisely when an operator most wants to send one.
      create table if not exists broadcasts (
        id           uuid        primary key default gen_random_uuid(),
        category     text        not null check (category in (${sqlValues(CATEGORIES)})),
        priority     text        not null check (priority in (${sqlValues(PRIORITIES)})),
        template_id  text        not null,
        params       jsonb       not null default '{}'::jsonb,
        audience     text        not null default 'all' check (audience in ('all', 'listed')),
        user_ids     uuid[]      not null default '{}',
        dedupe_key   text        not null,
        created_by   text        not null,
        created_at   timestamptz not null default now(),
        fanned_out_at timestamptz,
        recipients   integer,
        constraint broadcasts_listed_has_users
          check (audience <> 'listed' or cardinality(user_ids) > 0)
      );
    `,
  },
  {
    version: 8,
    name: 'quota-exhausted-reason',
    up: `
      -- Widen deliveries.reason to admit 'quota_exhausted' — micro-org#243.
      --
      -- An expand, and only an expand: every value version 5 admitted is still admitted, so a
      -- replica of the OLD code writing 'upstream_error' against this schema is unaffected and a
      -- rollback needs nothing. That ordering matters more than usual here, because the whole
      -- point of the new value is that it is written by the code path an operator reaches for
      -- while mail is already not going out.
      --
      -- The constraint is dropped by the name Postgres gave the inline column CHECK in version 5.
      -- 'if exists' rather than a bare drop: a database built by a future consolidated baseline
      -- may not carry that auto-generated name, and a migration that fails on a database with no
      -- constraint to remove would be a boot failure over a constraint that was already correct.
      alter table deliveries drop constraint if exists deliveries_reason_check;
      alter table deliveries
        add constraint deliveries_reason_check
        check (reason is null or reason in (${sqlValues(FAILURE_REASONS_AT_8)}));
    `,
  },
  {
    version: 9,
    name: 'reserved-domain-reason',
    up: `
      -- Widen deliveries.reason to admit 'reserved_domain' — micro-org#390.
      --
      -- An expand, like version 8 and for the same reason: every value version 8 admitted is still
      -- admitted, so a replica of the older code is unaffected and a rollback needs nothing.
      --
      -- This value exists to be ALERTED ON ABOVE ZERO. \`pipeline.ts\` declines to route email to a
      -- reserved domain, so a row carrying this reason means the routing rule did not run — which
      -- is what happened on mainnet between 2026-08-05 and 2026-08-11, when the deployed process
      -- predated the rule and spent the whole mail allowance on \`beacon.test\`. The database is the
      -- durable half of that signal; the counter label is the half that pages.
      --
      -- Dropped by name with 'if exists' for the same reason version 8 gives: a database built
      -- from a future consolidated baseline may not carry the auto-generated name, and failing on
      -- a constraint that was already correct would be a boot failure over nothing.
      alter table deliveries drop constraint if exists deliveries_reason_check;
      alter table deliveries
        add constraint deliveries_reason_check
        check (reason is null or reason in (${sqlValues(FAILURE_REASONS)}));
    `,
  },
  {
    version: 10,
    name: 'delivery-network',
    up: `
      -- WHICH ESTATE ASKED FOR THIS MAIL — the network consolidation (micro-deploy
      -- \`docs/network-consolidation.md\`).
      --
      -- notify stays ONE pipeline with ONE quota, deliberately. Two pipelines would mean two
      -- SMTP allowances against one 150/day account, two dead-letter views to check and two
      -- places to look when a user says they got nothing — and the thing that actually differs
      -- between the estates is not the sending, it is which event triggered it. That is a fact
      -- about the DELIVERY, so it goes in a column rather than in a second deployment.
      --
      -- NULLABLE, and not back-filled. Every row written before this migration was sent by a
      -- single-network pod, so its estate is knowable from the deployment — but knowable is not
      -- recorded, and stamping 'mainnet' across history would turn an inference into an
      -- assertion. Null reads as "before the estate was tracked", which is true.
      --
      -- Checked rather than free text, for the same reason every other enum here is: an alert
      -- that groups by this column must not acquire a third series because somebody wrote
      -- 'Mainnet'.
      alter table deliveries add column if not exists network text;
      alter table deliveries drop constraint if exists deliveries_network_check;
      alter table deliveries
        add constraint deliveries_network_check
        check (network is null or network in ('mainnet', 'testnet'));

      -- The access path for "show me this estate's dead letters", which is the query an operator
      -- runs during an incident. Partial on the terminal states for the same reason
      -- \`deliveries_deadletter_idx\` is: history is large and the failures are not.
      create index if not exists deliveries_network_deadletter_idx
        on deliveries (network, created_at desc)
        where state in ('undeliverable', 'dead');
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
 * How an existing hand-built schema is adopted. Zero for a new service, which makes it a no-op.
 * See the service template's note: a service migrated from the old estate sets this to the
 * version whose DDL matches the live schema, ships one release, then sets it back to 0.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test reset. Order is irrelevant: CASCADE is used. */
export const ALL_TABLES: readonly string[] = [
  'digest_entries',
  'digests',
  'deliveries',
  'notifications',
  'channel_targets',
  'preferences',
  'broadcasts',
  'inbox',
  'jobs',
]
