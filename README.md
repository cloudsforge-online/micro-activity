# `cloudsforge-activity`

[![ci](https://github.com/cloudsforge-online/micro-activity/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-activity/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

The estate's **canonical activity record**. It subscribes to every registered domain topic and
writes one immutable row per user-visible fact, so that "what happened to my account" is a single
ordered narrative rather than eight services each holding a fragment of it.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

**It owns no facts of its own.** Every row here is the shadow of something another service already
committed. That is why there is no route that creates a record from a product's request — AD-11, and
`src/server.ts:8-14` states it at the top of the file that would have carried one. A direct write is
a write that can happen without the domain change having committed, which is a feed entry describing
a transaction that rolled back. If it is not worth an outbox row, it is not worth a feed entry.

Two further refusals, both structural:

- **It publishes nothing.** `contracts-events` registers no `activity.*` topic, so there is no
  outbox table, no relay job and no signing secret in the deploy (`src/migrations.ts:11-16`).
- **It never edits a row.** Not by convention — a trigger refuses `UPDATE` outright
  (`src/migrations.ts:126-135`). A correction is a new record.

---

## 1. Routes

Read out of `buildRoutes()` at `src/server.ts:277-406`. There is no path prefix: paths are exactly
as written, unversioned.

| Method | Path | Who may call it | `Idempotency-Key` | What it does |
| --- | --- | --- | --- | --- |
| `GET` | `/livez` | anyone | no | Static liveness. Consults nothing, deliberately — a liveness probe that dials a dependency restarts a healthy process every time the database blinks (`:282-287`). |
| `GET` | `/readyz` | anyone | no | Lifecycle report; 503 until ready. Postgres is a hard probe, identity's JWKS a soft one (`src/index.ts:74-96`). |
| `GET` | `/metrics` | anyone | no | Prometheus text. **Unauthenticated** — unlike Lantern and Beacon, this service does not gate its scrape. Gauges are refreshed at scrape time; a refresh failure serves the previous values rather than losing every other series (`:298-313`). |
| `GET` | `/feed` | any authenticated principal | no | Keyset-paginated feed. A user reads their own; an operator reads whoever they name, or the **estate-wide** feed by omitting `userId`; a service token must name a `userId` and cannot reach the estate-wide query at all (`feedOwner`, `:425-434`). Filters: `limit` (1–200, default 50), `category`, `product`, `cursor`. |
| `GET` | `/feed/:id` | owner, or an operator | no | One record. `internal` records are 403 to a non-operator, not 404 — the id is already unguessable and pretending otherwise only obstructs the operator's own investigation (`:436-446`). |
| `POST` | `/ingest` | **service token only** | no — see below | The only way a record is ever created. |

**Nothing here takes an `Idempotency-Key`.** The five read routes have nothing to make idempotent,
and `/ingest` is deduped on the event's own identity instead: `(topic, event_id)` is the inbox
primary key and `source_event_id` is unique on the record table. A header the producer would have to
choose correctly is a weaker guarantee than a key the event already carries.

### `POST /ingest`, and why the order of its four steps is the security property

`src/server.ts:374-401`:

1. Authenticate. A **user** token is refused whatever roles it carries (`:376-379`).
2. Read the raw bytes, capped at 256 KiB *before* buffering (`readRaw`, `:517-529`).
3. Verify the HMAC over exactly those bytes (`src/ingest.ts:82-94`).
4. Only then parse.

Parsing first would put a JSON parser in front of the authentication, reachable by anyone who can
open a socket. And the signature is verified over the bytes that arrived, never over a
re-serialisation — `JSON.stringify(JSON.parse(body))` differs on key order, whitespace and number
formatting, so verifying anything else would be verifying something other than what the handler acts
on (`src/ingest.ts:74-81`).

The token and the signature answer different questions and neither implies the other: the token says
*who is calling*, the signature says *the body was not altered between the producer's outbox and this
handler*. Both are required.

Replies: `201 recorded`, `200 duplicate`, `200 erased`. A redelivery is **200, not 409** — it is the
producer doing exactly what at-least-once delivery requires of it, and an error answer would make the
relay retry for ever (`:387-391`).

### What happens to a topic this build cannot classify

There are two ways to be behind a producer and they take the same path: a topic this build's
**registry** has never heard of, and a topic the registry carries but `src/classify.ts` has no entry
for. The second is the one that used to crash — see "Who calls it" below.

It is filed, never dropped. `parseDelivery` (`src/ingest.ts:114-148`) recognises a well-formed but
unregistered topic and validates only the minimum a quarantine row needs — id, key, `occurredAt`,
producer, `correlationId`, payload — rather than rejecting the whole envelope over the topic alone.
The record lands as `category = 'unclassified'`, `visibility = 'internal'`, with its payload kept, so
it can be reclassified later from data that was never thrown away. `activity_unclassified_total` is
the backlog gauge; the ingest logs a warning per occurrence because this is a state where the service
is behind its producers, not a normal outcome.

`unclassified` is deliberately not one of the sixteen product categories, and a non-operator asking
to filter by it gets a 400 (`:466-472`).

### `identity.user.deleted` writes no feed entry

It **erases** (`src/ingest.ts:186-189`). Writing "your account was deleted" into the feed of a user
who no longer exists would leave a row keyed on the user id we were told to forget, in a table nobody
can read — personal data retained for no purpose, which is the thing being asked for. The inbox row
is the acknowledgement.

---

## 2. Background jobs

Two, and both are leased.

| Job | Kind | Lease key | Interval | What it does |
| --- | --- | --- | --- | --- |
| Inbox prune | `activity.inbox.prune` | `global` | hourly (`src/jobs.ts`) | Deletes inbox rows older than `ACTIVITY_INBOX_RETENTION_DAYS`. |
| Record prune | `activity.records.prune` | `global` | six-hourly (`src/jobs.ts`) | **Enforces storage limitation.** Deletes records past the retention period of their `retention_class` — see `src/retention.ts` for the four periods and the lawful basis for each. |

**How to see the record prune having run**, in increasing order of how much it survives:
`activity_records_pruned_total{class="…"}` counts deletions per class; the `record retention prune`
log line reports counts and class names (never a record, never a field of one); the `jobs` row for
`activity.records.prune` carries its next `run_at`, so an operator can query the schedule itself.
And `activity_retention_overdue_total` is scraped from the `activity_records_retention` **view**
rather than from anything the job reports — because a job that has stopped running reports nothing,
and "nothing" and "nothing to do" are the two states that number exists to tell apart. Healthy is a
flat zero.

**If two replicas run it:** they cannot. The job row is claimed `FOR UPDATE SKIP LOCKED` by
`@cloudsforge/jobs`, and the lease key names the contended resource rather than a row — this is an
estate-wide sweep over one table, so what two concurrent runs would break is that they would delete
each other's rows and each report a count that is wrong (`src/jobs.ts:9-12`).

There is **no `setInterval` in this repository**. Recurrence is the boot seed
(`seedRecurring`, `:32-36`) plus a re-arm on the runner's `completed` event (`:48-63`) — it cannot
re-arm from inside its own handler, because the runner deletes the row on success *after* the handler
returns, so a self-enqueue would be deleted a moment later and the schedule would stop silently. A
dead-lettered recurring job is deliberately **not** re-armed: the row stays, `jobs_dead_total`
increments and `jobs_overdue` climbs, which is how an operator finds out.

Gauges (`jobs_pending`, `jobs_overdue`, `activity_unclassified_total`) are sampled on scrape rather
than on a timer (`src/index.ts:117-125`).

---

## 3. The database

Three migrations (`src/migrations.ts:39-138`), run **only** by `src/migrator.ts`. The service asserts
the schema version at boot and exits rather than serving below it (`src/index.ts:52-61`) — a replica
of new code answering against an old schema corrupts data quietly, whereas a container that refuses
to start is a deploy that visibly stops.

| Table | Purpose |
| --- | --- |
| `jobs` | The lease table, taken verbatim from `JOBS_SCHEMA_SQL` rather than hand-copied (`:47`). Copying it by hand is how a service ends up without the `(kind, key)` unique constraint, which silently turns every recurring enqueue into a duplicate run. |
| `inbox` | `(topic, event_id)` — the effectively-once guard. |
| `activity_records` | The feed. |

### The constraints that carry meaning

- **`inbox` primary key `(topic, event_id)`** (`:55-60`). Delivery is at-least-once; the consumer is
  what makes it effectively-once. The insert and the record insert share **one transaction**
  (`src/ingest.ts:166-207`), so a handler that fails leaves no inbox row and the redelivery is
  processed rather than swallowed. "Record, then handle" is the naive version of this, and it loses
  events.

- **`activity_records_source_uniq unique (source_event_id)`** (`:98`). Not redundant with the inbox,
  and not two dedupes that can disagree — they are written in the same transaction. The inbox row is
  the generic *handler-once* guard; this is the *table invariant*, and it is the one that still holds
  if some future code path writes a record by another route. A constraint that exists only in
  application logic is a constraint that holds until the second caller. It is also what makes the
  prune job safe to get slightly wrong: prune a row while its producer could still redeliver and the
  redelivery is treated as new — and then refused here (`src/jobs.ts:73-78`).

- **The immutability trigger `activity_records_immutable`** (`:126-135`). `UPDATE` raises. A feed
  entry that can be edited after the fact is not a record of what happened, it is a record of what
  somebody last said happened, and the two are indistinguishable afterwards. **`DELETE` is still
  allowed**, deliberately: erasure under `identity.user.deleted` removes the row entirely, which is a
  different claim from rewriting it to say something else.

- **`activity_records_category`** (`:99`) is rendered from `STORED_CATEGORIES` in TypeScript
  (`:36`), so the column and the union cannot drift. Same for `visibility` (`:100`).

- **`amount` is `text` with a numeric-shape CHECK** (`:87`, `:101`). Not `numeric(40,18)`, which
  would return `10.000000000000000000` for a deposit of 10 — a feed that reformats a user's money is
  a feed they do not trust. The producer's exact decimal is preserved and the CHECK is what keeps it
  a number.

- **`user_id` is nullable** (`:75`). A reconciliation run and a chain-level fault are domain events
  worth a permanent record and have no owner. A synthetic owner would put them in somebody's feed.

- **`occurred_at` is the ordering key, not `recorded_at`** (`:78`). A feed ordered by arrival
  reorders itself whenever a producer retries.

Four indexes exist so that every filter combination is a prefix of one of them and a page is an index
scan rather than a sort of the user's whole history (`:107-118`).

---

## 4. Configuration

Declared in `src/env.ts:149-170`; `.env.example` mirrors it exactly, and the two agree — every
variable in one appears in the other, with the same defaults.

Validation happens **at import**, so a bad value exits before the logger exists. `src/env.ts:182-194`
writes the fatal line by hand from a literal rather than through telemetry, because nothing that can
itself fail may sit between a configuration error and the report of it.

### Required

| Variable | What breaks if it is wrong |
| --- | --- |
| `ACTIVITY_DATABASE_URL` | Nothing starts. This is the **only** connection string this service may read; CI greps for a second one (rule 1). |
| `IDENTITY_JWKS_URL` | Every authenticated route answers **503 `verifier_unavailable`**, not 401 — answering 401 would sign every user in the estate out because identity is having a bad minute (`src/server.ts:245-250`). |
| `IDENTITY_ISSUER` | Tokens minted by identity fail issuer validation; the same 503/401 surface. |
| `ACTIVITY_INGEST_SECRETS` | Ingest refuses everything. A **comma-separated list, newest first**, each ≥ 24 characters, maximum four (`:84-103`). It is a list because rotation must not require every producer in the estate and this service to change in the same instant — and a single-secret variable is how a secret ends up never being rotated at all. A known placeholder is refused at boot; length is the only entropy proxy available and it is set above the point at which a human-chosen string is plausible. Verifying against a rotated-out key logs a warning, so an operator can see when the window may be closed (`src/ingest.ts:89-93`). |

### Optional

| Variable | Default | What breaks if it is wrong |
| --- | --- | --- |
| `PORT` | `4000` | — |
| `NODE_ENV` | `development` | — |
| `LOG_LEVEL` | `info` | Refused at boot if not one of `debug`/`info`/`warn`/`error`. |
| `ACTIVITY_DATABASE_POOL_MAX` | `10` (1–100) | A pool larger than the database's connection budget divided by the replica count exhausts Postgres for everything else the moment this scales. |
| `ACTIVITY_DELIVERY_TOLERANCE_MS` | `300000` (5 000–900 000) | How much clock skew and relay delay a signature may carry. **A knob to turn down, not up**: widening it makes a captured request a longer-lived credential. |
| `ACTIVITY_INBOX_RETENTION_DAYS` | `30` (7–365) | Must outlive every producer's retry horizon. Too short and a redelivery is processed as new — caught by the unique constraint, which is exactly why that constraint is in the schema. |
| `ACTIVITY_RETENTION_FINANCIAL_DAYS` | `1825` (365–1825) | How long a financial record is kept. Five years is an AML/CTF record-keeping obligation. |
| `ACTIVITY_RETENTION_PERSONAL_DAYS` | `730` (30–730) | A person's own timeline: the product promise, and reconstructing an account takeover. |
| `ACTIVITY_RETENTION_OPERATIONAL_DAYS` | `400` (30–400) | Owner-less records with no financial content. |
| `ACTIVITY_RETENTION_QUARANTINE_DAYS` | `90` (7–90) | `unclassified` rows. Short on purpose: a topic nobody classified must not become a permanent store of a payload nobody has read. |
| `INSTANCE_ID` | hostname | Names this replica in `jobs.locked_by`. |
| `CLOUDSFORGE_TAG` | `dev` | Reported on every log line and in the release manifest. |

**Every `ACTIVITY_RETENTION_*_DAYS` maximum is its own default, and that is the point.** A
deployment may shorten a retention period and can never lengthen one, so the numbers in
`src/retention.ts` are an upper bound on what any deployment of this service retains rather than a
suggestion it is free to ignore — `ACTIVITY_RETENTION_FINANCIAL_DAYS=3650` is refused by name at
boot. Nothing needs to be set: an estate that configures none of this still enforces a period.

`OUTBOX_SIGNING_SECRET` is absent deliberately — this service publishes nothing. `OTEL_*` is read by
the OpenTelemetry SDK loaded ahead of the process, not by `src/env.ts`, so under rule 9 it is not
declared here (`src/index.ts:10-13`).

---

## 5. What it talks to

| Upstream | What it calls | Verified at | When it is down |
| --- | --- | --- | --- |
| Postgres | its own database only | `src/index.ts:45-50` | **Fail-closed.** `/readyz` reports not-ready via a hard probe and the balancer takes the replica out. |
| Identity | `IDENTITY_JWKS_URL` — JWKS fetch only, by `@cloudsforge/auth`'s `Verifier` | `src/index.ts:100` | **Soft probe, and 503 rather than 401 on the request path** (`src/index.ts:87-96`, `src/server.ts:245-250`). Marking it hard would remove every service in the estate from its balancer on one identity blip, which is a cascade rather than a safety measure. It matters more here than elsewhere: ingest is authenticated by a signature *as well as* a token, so a feed that stopped ingesting because identity blinked would fall behind for a reason unrelated to anything it does. |

**Nothing else.** It makes no outbound call to any domain service. Producers push to it; it pulls from
nobody.

### Who calls it

Every service that publishes a registered topic, via its outbox relay. All 61 registered topics are
classified (`src/classify.ts`) and the mapping is enforced at compile time —
`satisfies Readonly<Record<TopicName, TopicClassifier>>` means adding a topic to `contracts-events`
without adding a row here is a **type error in this repository**, which is the property worth having.
The alternative is a topic that quietly lands in `unclassified` for six months.

That guarantee holds when the two are compiled together, which is exactly when it is least needed.
When `contracts-events` moves ahead of a deployed build of this service, the type error is not the
error you get — so the *runtime* lookup is typed `Partial` (`CLASSIFIER_TABLE` in `src/classify.ts`)
and a registered topic with no local classifier quarantines. It used to dereference `undefined` and
500, which is the defect micro-org#198 records.

Seven of the sixteen categories — `transfer` beyond ledger entries, `conversion`, `ownership`,
`trading`, `reward`, `community`, `api` — have no producer yet. The set describes what the feed
covers, not what has happened so far (`src/categories.ts:10-13`).

---

## 6. Running and testing

```bash
pnpm install
pnpm typecheck
pnpm migrate        # one-shot, under an advisory lock. NEVER the service process.
pnpm start
```

The suite needs a real Postgres whose database name contains `test` — the database-backed files
truncate between cases:

```bash
docker run --rm -d --name activity-pg -p 5432:5432 \
  -e POSTGRES_USER=cloudsforge -e POSTGRES_PASSWORD=CHANGE_ME -e POSTGRES_DB=activity_test \
  postgres:16

ACTIVITY_TEST_DATABASE_URL=postgres://cloudsforge:CHANGE_ME@127.0.0.1:5432/activity_test pnpm test
```

`--test-concurrency=1` is in the `test` script and is **required, not a preference**: `node:test` runs
files in parallel by default, a `TRUNCATE` takes an `AccessExclusiveLock`, and one file's reset
deadlocks against another file's inserts with `40P01` (`package.json:13`).

Without the DSN the database-backed cases skip. That is the estate's known green-while-proving-nothing
failure mode (18-build-status §3.3) — CI supplies the DSN so it does not happen there.

---

## 7. Known gaps

- **`/metrics` is unauthenticated here**, while Lantern and Beacon gate theirs. Nothing on this
  endpoint names a user, but it does publish per-producer ingest lag, which is a picture of which
  services are behind. Recorded rather than changed: it is a deployment decision about what is
  reachable from where, not a service one.
- **Seven categories have no producer.** Listed above; each is waiting on a service to publish its
  own topic rather than on anything in this repository.
- **`ledger.entry.posted` is filed as `transfer`** (`src/classify.ts:176-181`), which is the honest
  category and not the useful one: the entry itself does not know whether it was a purchase, a reward
  or a conversion. Those land better once billing, market and trade publish their own topics.
- **No frontend topic is registered anywhere in the estate** (18-build-status §3.3l), so nothing
  user-initiated in a browser reaches this feed.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
