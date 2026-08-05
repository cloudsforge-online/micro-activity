/**
 * The canonical feed: reading it, and writing exactly one row per event.
 *
 * ## Cursor pagination, and why `OFFSET` is not an option here
 *
 * A feed is the one place `OFFSET` is guaranteed to be wrong. Records arrive continuously, and
 * `OFFSET 20` means "skip twenty rows of whatever the query returns *now*" — so an event that
 * lands between page one and page two pushes one entry off the end of page one and onto the front
 * of page two, where the user sees it twice, and another entry is never shown at all. On a
 * transaction history that is not a cosmetic bug.
 *
 * Keyset pagination asks a different question: "the rows after this exact position". New arrivals
 * sort ahead of the cursor and simply are not in the pages already being read. The position is
 * `(occurred_at, id)` and not `occurred_at` alone, because two events can share a millisecond and
 * a cursor on the timestamp would silently drop whichever of them sorted second.
 */

import type { Sql, TransactionSql } from 'postgres'
import type { StoredCategory, Visibility } from './categories.ts'

export type Db = Sql
export type Tx = TransactionSql

export interface ActivityRecord {
  readonly id: string
  readonly userId: string | null
  readonly occurredAt: string
  readonly recordedAt: string
  readonly category: StoredCategory
  readonly type: string
  readonly subjectUrn: string
  readonly summary: string
  readonly amount: string | null
  readonly assetCode: string | null
  readonly correlationId: string
  readonly sourceEventId: string
  readonly sourceTopic: string
  readonly producer: string
  readonly visibility: Visibility
}

export interface NewRecord {
  readonly userId: string | null
  readonly occurredAt: string
  readonly category: StoredCategory
  readonly type: string
  readonly subjectUrn: string
  readonly summary: string
  readonly amount: string | null
  readonly assetCode: string | null
  readonly correlationId: string
  readonly sourceEventId: string
  readonly sourceTopic: string
  readonly producer: string
  readonly visibility: Visibility
  readonly payload: Record<string, unknown>
}

interface RecordRow {
  readonly id: string
  readonly user_id: string | null
  readonly occurred_at: Date
  readonly recorded_at: Date
  readonly category: string
  readonly type: string
  readonly subject_urn: string
  readonly summary: string
  readonly amount: string | null
  readonly asset_code: string | null
  readonly correlation_id: string
  readonly source_event_id: string
  readonly source_topic: string
  readonly producer: string
  readonly visibility: string
}

const COLUMNS =
  'id, user_id, occurred_at, recorded_at, category, type, subject_urn, summary, amount, asset_code, correlation_id, source_event_id, source_topic, producer, visibility'

function toRecord(row: RecordRow): ActivityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    category: row.category as StoredCategory,
    type: row.type,
    subjectUrn: row.subject_urn,
    summary: row.summary,
    amount: row.amount,
    assetCode: row.asset_code,
    correlationId: row.correlation_id,
    sourceEventId: row.source_event_id,
    sourceTopic: row.source_topic,
    producer: row.producer,
    visibility: row.visibility as Visibility,
  }
}

/**
 * Write one record.
 *
 * `on conflict do nothing` on `source_event_id`, returning null for the conflict. The caller
 * distinguishes "written" from "already had it", which is what the duplicates metric counts —
 * and a redelivery is a normal, expected event under at-least-once delivery, not an error to
 * log at a level that wakes somebody up.
 */
export async function insertRecord(tx: Tx, input: NewRecord): Promise<ActivityRecord | null> {
  const rows = await tx<RecordRow[]>`
    insert into activity_records (
      user_id, occurred_at, category, type, subject_urn, summary, amount, asset_code,
      correlation_id, source_event_id, source_topic, producer, visibility, payload
    ) values (
      ${input.userId},
      ${input.occurredAt},
      ${input.category},
      ${input.type},
      ${input.subjectUrn},
      ${input.summary},
      ${input.amount},
      ${input.assetCode},
      ${input.correlationId},
      ${input.sourceEventId},
      ${input.sourceTopic},
      ${input.producer},
      ${input.visibility},
      ${tx.json(input.payload as Record<string, never>)}
    )
    on conflict (source_event_id) do nothing
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toRecord(row) : null
}

export async function getRecord(sql: Db, id: string): Promise<ActivityRecord | null> {
  const rows = await sql<RecordRow[]>`
    select ${sql.unsafe(COLUMNS)} from activity_records where id = ${id}
  `
  const row = rows[0]
  return row ? toRecord(row) : null
}

/**
 * Erase everything belonging to a user.
 *
 * `identity.user.deleted` is described in the topic registry as "FIRST. Erasure. Every service
 * holding user_id must acknowledge within the SLA." This service holds a permanent, itemised
 * narrative of that user's money, so it is one of the services that most needs to honour it.
 *
 * A delete rather than an anonymisation: a feed entry stripped of its user is not anonymous, it
 * is a timestamped sequence of amounts that re-identifies trivially against any other record.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`WHERE user_id = $1` WAS NOT ERASURE, AND THE ROWS IT LEFT BEHIND WERE THE WORST ONES.**
 *
 * That was the whole of this function. It erased every row this service had successfully
 * *attributed* to the user and left behind every row where the attribution had failed — which is
 * precisely the set of rows nobody had ever looked at. Two confirmed sources, and neither is rare:
 *
 *   1. **The quarantine.** `classify.ts`'s `!known` branch files an unrecognised topic with
 *      `userId: null` deliberately — reading an owner out of a payload whose schema this build has
 *      never seen would be a guess, and a wrong guess puts one person's event in another's feed.
 *      That refusal is right and it stays. But the row is still keyed on the user in every way that
 *      matters: the envelope key reaches `subject_urn`, and the payload can carry the id outright.
 *      An unknown topic is by definition one whose contents nobody has reviewed, so a quarantined
 *      row is simultaneously the row most likely to hold something personal and the row erasure
 *      could not reach. Both halves of that were true at once.
 *   2. **Classifiers that return `userId: () => null`** for an operational event — the
 *      reconciliation, the sweep, the season opening. Those genuinely have no owner, so they are
 *      not the problem; what they establish is that `user_id IS NULL` is a normal, populated state
 *      of this table rather than a corner case, which is why the gap was invisible.
 *
 * So erasure now asks the question three ways, and the second two are deliberately scoped to
 * `user_id is null`:
 *
 *   * `user_id = $1` — the rows this service knows are the user's.
 *   * `subject_urn` ending in the id — `urn:cloudsforge:<producer>:<aggregate>:<key>` is built from
 *     the ENVELOPE KEY (`subjectUrnFor`), and every identity, custody and billing topic is keyed by
 *     the user. A quarantined `identity.*` topic puts the user's id in that column and nowhere else.
 *     Matched as a `:<id>` suffix rather than with a bare `like '%id%'`, so it can only match the
 *     key segment, which is the only segment a user id is ever in.
 *   * the payload containing the id — `payload::text like` over the whole document, because the id
 *     may be at any depth and under any key name, on a topic whose shape this build does not know.
 *     A jsonb path query would have to name the path, which is the one thing an unknown topic
 *     denies us. This is a sequential scan and it is the right trade: erasure runs once per user,
 *     under an SLA measured in days, and a scan that is certain beats an index lookup that can miss.
 *
 * **Why the last two are restricted to `user_id is null`.** An attributed row belongs to the user in
 * `user_id` and to nobody else, and it is already covered by the first clause. Letting a text match
 * delete attributed rows would mean one person's erasure could delete another person's record for
 * mentioning them — a defect that reads as data loss rather than as a leak, and therefore one
 * nobody would find quickly. It cannot arise here anyway: `redact.ts` admits only the keys the
 * classifier declared, and `THE RULE: a classifier may not read a payload key it has not declared`
 * refuses a declaration for a key the classifier does not read, so a second party's identifier is
 * dropped at ingest rather than left in somebody else's row. The two mechanisms are load-bearing
 * for each other, which is why they landed together.
 *
 * The id is interpolated as a bound parameter and never as statement text; the caller has already
 * checked it against `UUID_PATTERN`, so the `%` and `_` in a LIKE pattern have nothing to escape.
 * `ilike` rather than `like`, because a uuid Postgres rendered is lower case and a uuid a producer
 * typed into a payload need not be — and an erasure that missed on letter case would miss silently.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why this table is NOT keyed on a pseudonym the way `analytics` is — a considered no
 *
 * `analytics/src/pseudonym.ts` is the estate's best piece of privacy engineering and the obvious
 * thing to copy: a per-subject salt, `subject_key = HMAC(pepper, subject || salt)`, and erasure
 * that destroys the salt rather than the rows, after which the pseudonym is unreachable from the
 * person. It was assessed for this table and refused, for one reason that is fatal and several
 * that are merely expensive.
 *
 * **The fatal one: that construction's whole value is that the rows are ANONYMOUS afterwards, and
 * these rows are not.** An analytics row is an event name, a timestamp and some counters — destroy
 * the salt and what is left is genuinely about nobody. An activity row is a summary in the second
 * person, an amount, an asset code, a subject URN and a timestamp. This function's own header
 * already makes the argument and it is the same one: "a feed entry stripped of its user is not
 * anonymous, it is a timestamped sequence of amounts that re-identifies trivially against any other
 * record." A withdrawal of an exact decimal at an exact second joins against the ledger, the wallet
 * service and the chain itself. Destroying a salt would make that row unattributable *by us* while
 * leaving it re-identifiable by anyone holding a second dataset — pseudonymisation offered as a
 * substitute for erasure, which is the one thing it is not.
 *
 * And the premise does not apply. The issue asks for a pseudonym "so erasure has something to
 * destroy"; this table erases by DELETE, and a row that no longer exists is strictly stronger than
 * a key that can no longer be computed. Adding a pseudonym would not give erasure something to
 * destroy — it already has the row.
 *
 * What it would cost, since a refusal should be honest about what it is declining:
 *
 *   * **It moves the identifier rather than removing it.** `subject_urn` is built from the envelope
 *     key and `payload` can carry the id at any depth — the two hiding places this function was
 *     just widened to reach. Pseudonymising `user_id` and leaving those is the same defect one
 *     column to the left, and pseudonymising all three destroys the feed's own indexes.
 *   * **A second secret in the deploy.** The pepper's loss is the silent loss of every user's feed,
 *     for a service whose product promise is that the feed is durable.
 *   * **A new failure mode with no owner.** Erasure becomes "find the salt, delete the rows, delete
 *     the salt", and the interleaving where the salt is gone and the rows are not leaves records
 *     that nothing can ever attribute *or* erase — the exact class of orphan this widening exists
 *     to eliminate.
 *
 * Reassess this the day a record is written whose content is genuinely non-identifying. Today the
 * content IS the identification, so the answer is to delete it.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    delete from activity_records
     where user_id = ${userId}
        or (
             user_id is null
             and (
                   subject_urn ilike ${`%:${userId}`}
                   or payload::text ilike ${`%${userId}%`}
                 )
           )
    returning id
  `
  return rows.length
}

export interface RetentionSummary {
  readonly retentionClass: string
  readonly retentionDays: number
  readonly records: number
  readonly overdue: number
}

/**
 * What the retention view says, for the metrics scrape.
 *
 * A function rather than a query inlined into `index.ts`, and the reason is coverage rather than
 * tidiness: the composition root runs the whole service, so nothing in a suite can reach a query
 * written there. A misspelled column in the scrape path would be a `/metrics` endpoint that 500s in
 * production and a green build — which is the same class of defect as a retention period nothing
 * executes. Here it is one function with a test against a real view.
 *
 * `overdue` is the number that matters and it is computed by the DATABASE from the rows, not by
 * this process from what the prune job last reported. A job that has stopped running reports
 * nothing at all, and "nothing" and "nothing to do" are the two states the gauge exists to
 * separate.
 */
export async function retentionSummary(sql: Db): Promise<readonly RetentionSummary[]> {
  const rows = await sql<
    { retention_class: string; retention_days: number; records: string; overdue: string }[]
  >`
    select retention_class, retention_days, records, overdue
      from activity_records_retention
     order by retention_class
  `
  // `count(*)` is bigint, which the driver hands back as a string so a value past 2^53 is not
  // silently rounded. These are row counts of one table, so Number is safe and the cast is stated.
  return rows.map((row) => ({
    retentionClass: row.retention_class,
    retentionDays: row.retention_days,
    records: Number(row.records),
    overdue: Number(row.overdue),
  }))
}

/* ------------------------------------------------------------------ the feed */

export interface FeedQuery {
  /** Null asks for the operator feed: records with no owner, and internal ones. */
  readonly userId: string | null
  readonly category?: StoredCategory | undefined
  /** The producing service — `wallet`, `billing`. Spelled `product` on the wire. */
  readonly product?: string | undefined
  readonly limit: number
  readonly cursor?: string | undefined
  /** Operators only. A user is never shown a record nobody has classified. */
  readonly includeInternal: boolean
}

export interface FeedPage {
  readonly records: readonly ActivityRecord[]
  readonly nextCursor?: string
}

export class BadCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadCursorError'
  }
}

interface Cursor {
  readonly occurredAt: Date
  readonly id: string
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(value: string): Cursor {
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  const separator = decoded.indexOf('|')
  if (separator < 0) throw new BadCursorError('cursor is not a cursor this service issued')
  const at = new Date(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)
  if (Number.isNaN(at.getTime()) || id === '') {
    throw new BadCursorError('cursor is not a cursor this service issued')
  }
  return { occurredAt: at, id }
}

/**
 * One page of the feed.
 *
 * The filters are composed as SQL fragments rather than by building a string, so a category or a
 * product name is a bound parameter and never part of the statement text. Both are already
 * validated at the edge; being parameterised as well is the difference between two checks and one.
 */
export async function listFeed(sql: Db, query: FeedQuery): Promise<FeedPage> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null

  const rows = await sql<RecordRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from activity_records
     where ${query.userId === null ? sql`user_id is null` : sql`user_id = ${query.userId}`}
       ${query.includeInternal ? sql`` : sql`and visibility = 'user'`}
       ${query.category ? sql`and category = ${query.category}` : sql``}
       ${query.product ? sql`and producer = ${query.product}` : sql``}
       ${cursor ? sql`and (occurred_at, id) < (${cursor.occurredAt}, ${cursor.id})` : sql``}
     order by occurred_at desc, id desc
     limit ${query.limit + 1}
  `

  // One more row than asked for is fetched, so "is there another page" is a fact rather than a
  // guess from a full page — which is the bug that makes a client poll one empty page for ever.
  const records = rows.slice(0, query.limit).map(toRecord)
  const last = rows[query.limit - 1]
  return rows.length > query.limit && last
    ? { records, nextCursor: encodeCursor({ occurredAt: last.occurred_at, id: last.id }) }
    : { records }
}

/**
 * The operator feed: every record, whoever it belongs to.
 *
 * Separate from `listFeed` rather than a flag on it. A flag that widened a user-scoped query into
 * an estate-wide one is one missing check away from being the worst data leak in the estate, and
 * the two queries want different indexes anyway.
 */
export async function listAllRecords(
  sql: Db,
  query: Omit<FeedQuery, 'userId' | 'includeInternal'>,
): Promise<FeedPage> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const rows = await sql<RecordRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from activity_records
     where true
       ${query.category ? sql`and category = ${query.category}` : sql``}
       ${query.product ? sql`and producer = ${query.product}` : sql``}
       ${cursor ? sql`and (occurred_at, id) < (${cursor.occurredAt}, ${cursor.id})` : sql``}
     order by occurred_at desc, id desc
     limit ${query.limit + 1}
  `
  const records = rows.slice(0, query.limit).map(toRecord)
  const last = rows[query.limit - 1]
  return rows.length > query.limit && last
    ? { records, nextCursor: encodeCursor({ occurredAt: last.occurred_at, id: last.id }) }
    : { records }
}
