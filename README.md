# `cloudsforge-activity`

[![ci](https://github.com/cloudsforge-online/micro-activity/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-activity/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

<!-- absorbed-banner -->
> ## ⚠️ This code no longer deploys as a service. It runs inside `micro-agora`.
>
> Absorbed in wave **M5c**, release **2026.8.106** (2026-08-30) of the estate's service-merge sequence.
>
> **The canonical source is [`micro-agora`](https://github.com/cloudsforge-online/micro-agora)
> at [`src/activity/`](https://github.com/cloudsforge-online/micro-agora/tree/main/src/activity).
> Edit there.** What is in this repository is the copy the merge was made from: it is frozen, no
> image is published from it, `cfctl bump` skips it, and nothing in the estate runs it.
>
> **Why the repository still exists.** Its registry row survives as `absorbed(…)`, which is what
> keeps the Kubernetes `Service` of this name resolving — an `ExternalName` alias to `agora`, so
> every caller that addresses it by service name still reaches the code. `deployableRepos()` keeps
> the row and `releasableRepos()` drops it. The history here is also the history of the module.
>
> **What did not change**, and this is the point of the merge rather than an aside: the database is
> still its own, the routes are unchanged except where a collision forced a remount, the migrations
> still run under this module's name, and the trust boundary is unchanged. A merge moved a process
> boundary, not a responsibility.
>
> Everything below describes the domain, and remains accurate. Read the reasoning — including what
> was refused and why — in
> [`micro-deploy/docs/service-merge-plan.md`](https://github.com/cloudsforge-online/micro-deploy/blob/main/docs/service-merge-plan.md).

The estate's **bus tail, in one process**. Two modules, one listener, two databases:

- **`activity`** — the canonical activity record. It subscribes to every registered domain topic and
  writes one immutable row per user-visible fact, so that "what happened to my account" is a single
  ordered narrative rather than eight services each holding a fragment of it.
- **`notify`** (absorbed in wave M2, `src/notify/`) — the notification pipeline: event to
  notification mapping, preferences, templates, dedupe, digests, retries, delivery history, operator
  broadcasts and developer webhooks, over email, in-app, push, SMS and webhooks.

Both are pure consumers of the same event bus with near-identical topic sets, and neither publishes
anything. One process consumes the bus once and fans to two sinks: record, and deliver.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

**It owns no facts of its own.** Every row here is the shadow of something another service already
committed. That is why there is no route that creates a record from a product's request — AD-11, and
`src/server.ts` states it at the top of the file that would have carried one. A direct write is
a write that can happen without the domain change having committed, which is a feed entry describing
a transaction that rolled back. If it is not worth an outbox row, it is not worth a feed entry.

Two further refusals, both structural:

- **It publishes nothing.** `contracts-events` registers no `activity.*` topic, so there is no
  outbox table, no relay job and no signing secret in the deploy (`src/migrations.ts`).
- **It never edits a row.** Not by convention — a trigger refuses `UPDATE` outright
  (`src/migrations.ts`). A correction is a new record.

---

## 0. The merge, and the one thing it breaks

Wave M2 of micro-deploy's `docs/service-merge-plan.md`. What it did:

- **One listener, one port, one `/livez`, one `/readyz`, one `/metrics`.** notify's copies of the
  three operational routes are filtered out where they are built (`src/notify/module.ts`), not
  deleted — the standalone micro-notify service is still deployed and its route table is unchanged.
- **Two databases, never merged**, read through their existing variables. `src/migrator.ts` migrates
  both and REFUSES to run if the two DSNs address one database: both modules keep a ledger in a table
  called `schema_migrations` and both number their migrations from 1, so one shared database would
  silently skip the second module's tables and still exit 0.
- **Two network models, both kept.** activity holds one database per network and refuses a network it
  has no handle for. notify holds one database for both and carries the network as a column
  (`deliveries.network`). `RouteSpec.sql` in `src/kernel.ts` is what lets both be right at once: each
  route names the selector its `ctx.sql` is resolved from.
- **Two job runners with independent concurrency budgets.** Not one. See §2.
- **One `/readyz` with a hard probe per module.** A merged readiness reporting only activity's
  database would answer 200 while every notification in the estate was failing.

### What it breaks: `POST /ingest` is gone

Both services mounted it, and they verify it with **different secrets** —
`ACTIVITY_INGEST_SECRETS` and `NOTIFY_INGEST_SIGNING_SECRET`. One process cannot serve one path with
two secret sets and stay honest, so each module has an inbox of its own:

| Was | Is now | Verified with |
| --- | --- | --- |
| `POST http://activity:4000/ingest` | `POST /ingest/activity` | `ACTIVITY_INGEST_SECRETS` |
| `POST http://notify:4000/ingest` | `POST /ingest/notify` | `NOTIFY_INGEST_SIGNING_SECRET` |

`POST /ingest` answers **410 `ingest_path_split`** naming both successors, without reading the body
or the signature. **Every producer subscription in the estate names the old path verbatim and has to
be re-pointed** — the merge plan's promise that "the retired service's Service becomes a CNAME so no
caller changes on cutover day" does not hold for this wave, because a CNAME moves a host and this is
a path.

One mount accepting either secret was considered and refused. It would make each key a credential for
both sinks — the key that mints a "your key was exported" email would also write the canonical record
of what happened to a user's money — it would destroy rotation independence, nothing in an envelope
says which sink it was addressed to, and the two handlers do not answer the same thing (201/200 with
a record against a flat 202 with a pipeline outcome). The full argument is at `INGEST_PATHS` in
`src/routes.ts`.

---

## 1. Routes

activity's are declared in `createRoutes()` at `src/routes.ts`; notify's in `createRoutes()` at
`src/notify/server.ts`, mounted beside them by `createMergedServer` (`src/server.ts`). There is no
path prefix: paths are exactly as written, unversioned. Matching is first-wins, and activity goes
first so a mounted module cannot shadow the three operational routes.

| Method | Path | Who may call it | `Idempotency-Key` | What it does |
| --- | --- | --- | --- | --- |
| `GET` | `/livez` | anyone | no | Static liveness. Consults nothing, deliberately — a liveness probe that dials a dependency restarts a healthy process every time the database blinks. |
| `GET` | `/readyz` | anyone | no | Lifecycle report; 503 until ready. Postgres is a hard probe, identity's JWKS a soft one (`src/index.ts`). |
| `GET` | `/metrics` | anyone | no | Prometheus text. **Unauthenticated** — unlike Lantern and Beacon, this service does not gate its scrape. Gauges are refreshed at scrape time; a refresh failure serves the previous values rather than losing every other series. |
| `GET` | `/feed` | any authenticated principal | no | Keyset-paginated feed. A user reads their own; an operator reads whoever they name, or the **estate-wide** feed by omitting `userId`; a service token must name a `userId` and cannot reach the estate-wide query at all (`feedOwner`). Filters: `limit` (1–200, default 50), `category`, `product`, `cursor`. |
| `GET` | `/feed/:id` | owner, or an operator | no | One record. `internal` records are 403 to a non-operator, not 404 — the id is already unguessable and pretending otherwise only obstructs the operator's own investigation. |
| `POST` | `/ingest/activity` | signature only — see below | no — see below | The only way a record is ever created. |
| `POST` | `/ingest` | — | no | **410 `ingest_path_split`.** The path both modules used to serve; it names both successors and reads neither body nor signature. See §0. |
| `GET` | `/notifications` | any authenticated principal | no | notify. A user's own notifications; a service token needs `notify:read`. |
| `POST` | `/notifications/:id/read` | the owner | no | notify. 404 rather than 403 for someone else's — the scoping is in the `WHERE` clause. |
| `GET` | `/preferences` | any authenticated principal | no | notify. Per-category, per-channel preferences, plus the `critical` set that cannot be switched off. |
| `PUT` | `/preferences` | the owner | no | notify. |
| `POST` | `/ingest/notify` | signature only | no | notify's event-bus inbox. Always 202. |
| `POST` | `/admin/broadcasts` | operator | no | notify. Refuses `critical`, and refuses any template carrying a single-use credential. |
| `GET` | `/admin/deliveries` | operator | no | notify. The dead-letter view over every channel. |
| `POST` | `/admin/deliveries/:id/resend` | operator | no | notify. 202; 409 when there is nothing to resend. |

**Nothing here takes an `Idempotency-Key`.** The read routes have nothing to make idempotent,
and both ingest paths are deduped on the event's own identity instead: `(topic, event_id)` is the inbox
primary key and `source_event_id` is unique on the record table. A header the producer would have to
choose correctly is a weaker guarantee than a key the event already carries.

### `POST /ingest/activity`, and why the order of its three steps is the security property

`src/routes.ts`:

1. Read the raw bytes, capped at 256 KiB *before* buffering (`readRaw`).
2. Verify the HMAC over exactly those bytes (`src/ingest.ts`).
3. Only then parse.

Parsing first would put a JSON parser in front of the authentication, reachable by anyone who can
open a socket. And the signature is verified over the bytes that arrived, never over a
re-serialisation — `JSON.stringify(JSON.parse(body))` differs on key order, whitespace and number
formatting, so verifying anything else would be verifying something other than what the handler acts
on (`src/ingest.ts`).

The token and the signature answer different questions and neither implies the other: the token says
*who is calling*, the signature says *the body was not altered between the producer's outbox and this
handler*. Both are required.

Replies: `201 recorded`, `200 duplicate`, `200 erased`. A redelivery is **200, not 409** — it is the
producer doing exactly what at-least-once delivery requires of it, and an error answer would make the
relay retry for ever.

### What happens to a topic this build cannot classify

There are two ways to be behind a producer and they take the same path: a topic this build's
**registry** has never heard of, and a topic the registry carries but `src/classify.ts` has no entry
for. The second is the one that used to crash — see "Who calls it" below.

It is filed, never dropped. `parseDelivery` (`src/ingest.ts`) recognises a well-formed but
unregistered topic and validates only the minimum a quarantine row needs — id, key, `occurredAt`,
producer, `correlationId`, payload — rather than rejecting the whole envelope over the topic alone.
The record lands as `category = 'unclassified'`, `visibility = 'internal'`, with its payload kept, so
it can be reclassified later from data that was never thrown away. `activity_unclassified_total` is
the backlog gauge; the ingest logs a warning per occurrence because this is a state where the service
is behind its producers, not a normal outcome.

`unclassified` is deliberately not one of the sixteen product categories, and a non-operator asking
to filter by it gets a 400.

### `identity.user.deleted` writes no feed entry

It **erases** (`src/ingest.ts`). Writing "your account was deleted" into the feed of a user
who no longer exists would leave a row keyed on the user id we were told to forget, in a table nobody
can read — personal data retained for no purpose, which is the thing being asked for. The inbox row
is the acknowledgement.

---

## 2. Background jobs

Five, across two runners, and every one is leased.

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
each other's rows and each report a count that is wrong (`src/jobs.ts`).

There is **no `setInterval` in this repository**. Recurrence is the boot seed
(`seedRecurring`) plus a re-arm on the runner's `completed` event — it cannot
re-arm from inside its own handler, because the runner deletes the row on success *after* the handler
returns, so a self-enqueue would be deleted a moment later and the schedule would stop silently. A
dead-lettered recurring job is deliberately **not** re-armed: the row stays, `jobs_dead_total`
increments and `jobs_overdue` climbs, which is how an operator finds out.

notify's three — `notify.dispatch` (`queue`, every second), `notify.digest` (`windows`, every thirty
seconds) and `notify.broadcast` (`broadcast:<id>`) — run on a **second `JobRunner` with its own
concurrency budget** (`src/notify/jobs.ts`, `NOTIFY_JOB_CONCURRENCY`).

**That is not tidiness, it is the condition the merge plan makes this wave conditional on.**
`notify.dispatch` drains in a loop, `dispatchDue` sends deliveries serially, and `openSmtp` sets no
connect or socket timeout — so one unreachable mail host holds a slot for as long as the operating
system's TCP timeout. A single runner at activity's `concurrency: 2` would then never claim
`activity.inbox.prune`: the feed's retention would stop running because a mail server was down.
`src/starvation.test.ts` saturates notify's runner and proves an activity job is still claimed, and
then runs the counterfactual — one runner, one budget — and shows the same job never running at all.

The two modules' job KINDS do not collide (`activity.*` against `notify.*`), so
`jobs_failed_total{kind=…}` was never at risk. `jobs_pending` and `jobs_overdue` were: they carry no
`kind` at all, so each module's sample would overwrite the other's and a wedged queue would be
**absent** from the graph rather than high. Both modules write them through
`metrics.withLabels({ module })` (`@cloudsforge/telemetry`), which is a view over the same registry —
so one `/metrics` still carries both, as two series.

Gauges (`jobs_pending`, `jobs_overdue`, `activity_unclassified_total`, and notify's delivery and
reserved-domain gauges) are sampled on scrape rather than on a timer (`src/index.ts`).

---

## 3. The database

The schema is a list of versioned migrations in `src/migrations.ts`, run **only** by
`src/migrator.ts`. **How many there are is deliberately not written down here.** `SCHEMA_VERSION` is
computed at the foot of that file as the highest `version` in `MIGRATIONS`, so the number is derived
from the list rather than typed beside it — and this paragraph is why that matters, because it read
"three migrations" for as long as there had been four. Migration 4 (`retention`) landed and the
sentence did not. A count in prose is a claim nothing recomputes; `src/migrations.ts` is the one that
does.

The service asserts that version at boot and exits rather than serving below it
(`assertSchemaAtLeast(sql, SCHEMA_VERSION)`, `src/index.ts`) — a replica of new code answering
against an old schema corrupts data quietly, whereas a container that refuses to start is a deploy
that visibly stops.

| Relation | Purpose |
| --- | --- |
| `jobs` | The lease table, taken verbatim from `JOBS_SCHEMA_SQL` rather than hand-copied. Copying it by hand is how a service ends up without the `(kind, key)` unique constraint, which silently turns every recurring enqueue into a duplicate run. |
| `inbox` | `(topic, event_id)` — the effectively-once guard. |
| `activity_records` | The feed. |
| `activity_records_retention` | A **view**, not a table — migration 4 added no table, it added a `retention_class` column to `activity_records` and this. It answers "which rows are overdue" in one query on a morning when nothing has run for a month, and `src/index.ts` scrapes it into `activity_retention_overdue_total`, which is the alarm for the prune job having died. |

### The constraints that carry meaning

- **`inbox` primary key `(topic, event_id)`**. Delivery is at-least-once; the consumer is
  what makes it effectively-once. The insert and the record insert share **one transaction**
  (`src/ingest.ts`), so a handler that fails leaves no inbox row and the redelivery is
  processed rather than swallowed. "Record, then handle" is the naive version of this, and it loses
  events.

- **`activity_records_source_uniq unique (source_event_id)`**. Not redundant with the inbox,
  and not two dedupes that can disagree — they are written in the same transaction. The inbox row is
  the generic *handler-once* guard; this is the *table invariant*, and it is the one that still holds
  if some future code path writes a record by another route. A constraint that exists only in
  application logic is a constraint that holds until the second caller. It is also what makes the
  prune job safe to get slightly wrong: prune a row while its producer could still redeliver and the
  redelivery is treated as new — and then refused here (`src/jobs.ts`).

- **The immutability trigger `activity_records_immutable`**. `UPDATE` raises. A feed
  entry that can be edited after the fact is not a record of what happened, it is a record of what
  somebody last said happened, and the two are indistinguishable afterwards. **`DELETE` is still
  allowed**, deliberately: erasure under `identity.user.deleted` removes the row entirely, which is a
  different claim from rewriting it to say something else.

- **`activity_records_category`** is rendered from `STORED_CATEGORIES` in TypeScript, so the column and the union cannot drift. Same for `visibility`.

- **`amount` is `text` with a numeric-shape CHECK**. Not `numeric(40,18)`, which
  would return `10.000000000000000000` for a deposit of 10 — a feed that reformats a user's money is
  a feed they do not trust. The producer's exact decimal is preserved and the CHECK is what keeps it
  a number.

- **`user_id` is nullable**. A reconciliation run and a chain-level fault are domain events
  worth a permanent record and have no owner. A synthetic owner would put them in somebody's feed.

- **`occurred_at` is the ordering key, not `recorded_at`**. A feed ordered by arrival
  reorders itself whenever a producer retries.

The indexes on `activity_records` exist so that every filter combination the feed offers is a prefix
of one of them and a page is an index scan rather than a sort of the user's whole history. The prune
job has its own, leading with `retention_class`, so a sweep is a range scan over one class rather
than a scan of the whole table per run. Their number is not given here for the same reason the
migration count is not: this sentence said "four" from the day migration 4 added the fifth. They are
declared beside the tables they index in `src/migrations.ts`.

---

## 4. Configuration

Declared in `src/env.ts`; `.env.example` mirrors it exactly, and the two agree — every
variable in one appears in the other, with the same defaults.

Validation happens **at import**, so a bad value exits before the logger exists. `src/env.ts`
writes the fatal line by hand from a literal rather than through telemetry, because nothing that can
itself fail may sit between a configuration error and the report of it.

### Required

| Variable | What breaks if it is wrong |
| --- | --- |
| `ACTIVITY_DATABASE_URL` | Nothing starts. activity's database. |
| `NOTIFY_DATABASE_URL` | Nothing starts — `src/notify/env.ts` validates at import, so a merged pod refuses to boot on half a configuration rather than serving half a bus tail. It must address a **different** database from the one above; `src/migrator.ts` refuses otherwise. |
| `NOTIFY_INGEST_SIGNING_SECRET` | `POST /ingest/notify` refuses everything. Same shape rules as `ACTIVITY_INGEST_SECRETS` below, and deliberately a separate value: neither key may do the other's job. |
| `NOTIFY_PUBLIC_URL` | Every link inside a notification points somewhere wrong. Never the request's Host header — identity was burned by exactly that. |
| `IDENTITY_JWKS_URL` | Every authenticated route answers **503 `verifier_unavailable`**, not 401 — answering 401 would sign every user in the estate out because identity is having a bad minute (`src/server.ts`). |
| `IDENTITY_ISSUER` | Tokens minted by identity fail issuer validation; the same 503/401 surface. |
| `ACTIVITY_INGEST_SECRETS` | Ingest refuses everything. A **comma-separated list, newest first**, each one GENERATED with `openssl rand -base64 48`, maximum four. It is a list because rotation must not require every producer in the estate and this service to change in the same instant — and a single-secret variable is how a secret ends up never being rotated at all. **Each entry is held to a SHAPE, not to a deny-list**: base64 or hex only, at least 32 decoded bytes rather than 24 keystrokes, and a measured entropy floor. The old rule was a list of known-bad strings plus a 24-character floor, and it could not have refused `estate-only-outbox-secret-…` — 40 characters, on nobody's list — which is what that key actually was on 54 lines of a public compose file (micro-org #142). There is no NODE_ENV or CI exemption, and the entry on its way OUT of a rotation gets the same bar as the one coming in. Verifying against a rotated-out key logs a warning, so an operator can see when the window may be closed (`src/ingest.ts`). |

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
| `INSTANCE_ID` | hostname | Names this replica in `jobs.locked_by` and in `deliveries.leased_by`. |
| `ACTIVITY_DATABASE_URL_TESTNET` | unset | activity's testnet database. Unset is the single-network case: the selector then holds one handle and refuses a testnet request rather than answering it out of mainnet rows. **notify has no equivalent and must not gain one** — it is a class B′ singleton with one pipeline, one SMTP allowance and one dead-letter view, and the estate is a column on the delivery. |
| `CF_NETWORK_SINGLE` | unset | Which estate a single-network pod is, and the fallback for a request with no `CF-Network`. |
| `NOTIFY_DATABASE_POOL_MAX` | `10` (1–100) | As above, for notify's pool. The two pools are independent. |
| `NOTIFY_DELIVERY_MAX_ATTEMPTS` | `6` (1–20) | Retries before a delivery dead-letters. |
| `NOTIFY_DISPATCH_BATCH_SIZE` | `50` (1–500) | How many due deliveries one dispatch pass claims. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_REPLY_TO` | unset | **Unset is a supported mode, not a misconfiguration.** No mail is sent, deliveries are recorded `undeliverable_no_transport`, and `notify_failed_total{channel="email",reason="no_transport"}` counts them. 465 is implicit TLS and needs `SMTP_SECURE=true`; 587 is STARTTLS and needs it false. |
| `NOTIFY_WEBPUSH_URL`, `NOTIFY_MOBILEPUSH_URL`, `NOTIFY_SMS_URL`, `NOTIFY_GATEWAY_TOKEN` | unset | Same rule: an unconfigured channel is a recorded, countable outcome. |
| `CLOUDSFORGE_TAG` | `dev` | Reported on every log line and in the release manifest. |

**Every `ACTIVITY_RETENTION_*_DAYS` maximum is its own default, and that is the point.** A
deployment may shorten a retention period and can never lengthen one, so the numbers in
`src/retention.ts` are an upper bound on what any deployment of this service retains rather than a
suggestion it is free to ignore — `ACTIVITY_RETENTION_FINANCIAL_DAYS=3650` is refused by name at
boot. Nothing needs to be set: an estate that configures none of this still enforces a period.

`OUTBOX_SIGNING_SECRET` is absent deliberately — this service publishes nothing. `OTEL_*` is read by
the OpenTelemetry SDK loaded ahead of the process, not by `src/env.ts`, so under rule 9 it is not
declared here (`src/index.ts`).

---

## 5. What it talks to

| Upstream | What it calls | Verified at | When it is down |
| --- | --- | --- | --- |
| Postgres | its own database only | `src/index.ts` | **Fail-closed.** `/readyz` reports not-ready via a hard probe and the balancer takes the replica out. |
| Identity | `IDENTITY_JWKS_URL` — JWKS fetch only, by `@cloudsforge/auth`'s `Verifier` | `src/index.ts` | **Soft probe, and 503 rather than 401 on the request path** (`src/index.ts`, `src/server.ts`). Marking it hard would remove every service in the estate from its balancer on one identity blip, which is a cascade rather than a safety measure. It matters more here than elsewhere: ingest is authenticated by a signature *as well as* a token, so a feed that stopped ingesting because identity blinked would fall behind for a reason unrelated to anything it does. |

| SMTP relay | `SMTP_HOST`, on the delivery path only | not probed | **Unconfigured is a supported mode**, and a wedged one cannot stall the activity record — see §2. Two mail-quota protections are load-bearing and are enforced per delivery, so they are indifferent to which process runs them: `src/notify/reserved.ts` refuses RFC 6761 / RFC 2606 reserved domains before the allowance is spent proving they cannot resolve, and `src/notify/email.ts` classifies the provider's `535 … daily sending limit` as `quota_exhausted` — retryable, not consuming an attempt, waiting `QUOTA_RETRY_FLOOR_MS`. |
| Push / SMS gateways | `NOTIFY_WEBPUSH_URL`, `NOTIFY_MOBILEPUSH_URL`, `NOTIFY_SMS_URL` | not probed | Unconfigured is a supported mode. |

**Nothing else.** It makes no outbound call to any domain service. Producers push to it; it pulls from
nobody. notify never calls activity and never waits for it: a notification blocked on a feed write is
a security alert that does not arrive because a feed was slow.

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
covers, not what has happened so far (`src/categories.ts`).

---

## 6. Running and testing

```bash
pnpm install
pnpm typecheck
pnpm migrate        # one-shot, under an advisory lock. NEVER the service process.
pnpm start
```

The suite needs **two** real Postgres databases, each with `test` in the name — the database-backed
files truncate between cases, and both modules own a table called `inbox` and a table called `jobs`,
so one shared database would have one suite emptying the other's rows mid-test:

```bash
docker run --rm -d --name activity-pg -p 5432:5432 \
  -e POSTGRES_USER=cloudsforge -e POSTGRES_PASSWORD=CHANGE_ME -e POSTGRES_DB=activity_test \
  postgres:16
psql "postgres://cloudsforge:CHANGE_ME@127.0.0.1:5432/activity_test" -c 'create database notify_test'

ACTIVITY_TEST_DATABASE_URL=postgres://cloudsforge:CHANGE_ME@127.0.0.1:5432/activity_test \
NOTIFY_TEST_DATABASE_URL=postgres://cloudsforge:CHANGE_ME@127.0.0.1:5432/notify_test \
  pnpm test
```

Measured on this branch: **443 pass / 0 fail / 0 skipped** with both DSNs; **370** with only
activity's, which is a green run with seventy-three cases silently gone; **370 tests, 330 pass, 40
skipped** with neither. The workflow declares both names in `database-env-var`, which is what makes
a missing notify DSN fatal rather than a notice.

`--test-concurrency=1` is in the `test` script and is **required, not a preference**: `node:test` runs
files in parallel by default, a `TRUNCATE` takes an `AccessExclusiveLock`, and one file's reset
deadlocks against another file's inserts with `40P01` (`package.json`).

Without a DSN the database-backed cases skip, and note that `node:test` reports `skipped 0` when a
whole `describe` is skipped — the cases inside are not counted at all. That is the estate's known
green-while-proving-nothing failure mode (18-build-status §3.3); CI supplies both DSNs and treats a
skip of either OWN-prefix suite as fatal so it does not happen there.

---

## 7. Known gaps

- **`/metrics` is unauthenticated here**, while Lantern and Beacon gate theirs. Nothing on this
  endpoint names a user, but it does publish per-producer ingest lag, which is a picture of which
  services are behind. Recorded rather than changed: it is a deployment decision about what is
  reachable from where, not a service one.
- **Seven categories have no producer.** Listed above; each is waiting on a service to publish its
  own topic rather than on anything in this repository.
- **`ledger.entry.posted` is filed as `transfer`** (`src/classify.ts`), which is the honest
  category and not the useful one: the entry itself does not know whether it was a purchase, a reward
  or a conversion. Those land better once billing, market and trade publish their own topics.
- **No frontend topic is registered anywhere in the estate** (18-build-status §3.3l), so nothing
  user-initiated in a browser reaches this feed.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
