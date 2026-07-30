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
 */
export async function eraseUser(tx: Tx, userId: string): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    delete from activity_records where user_id = ${userId} returning id
  `
  return rows.length
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
