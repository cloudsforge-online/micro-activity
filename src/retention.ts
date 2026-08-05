/**
 * STORAGE LIMITATION: how long a record is kept, and the basis for each period.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **"KEEP FOR EVER" WAS THE POLICY UNTIL THIS FILE EXISTED, AND IT WAS NEVER WRITTEN DOWN.**
 *
 * `records.ts` describes this table as "a permanent, itemised narrative of that user's money", and
 * it meant it: the only recurring job in the repository pruned the *inbox*, never the records, and
 * the sole `DELETE` against `activity_records` was erasure. A retention period that nothing
 * executes is the estate's favourite defect — a check that cannot fail — wearing a compliance hat,
 * and "for ever" is the one answer that needs a justification rather than providing one.
 *
 * The product promise is real and is not being retracted: 01-product-vision sells "look back at
 * everything you did", and a feed that forgets last month is not that product. So the periods
 * below are long. What they are not is unbounded, and what they are not is undeclared.
 *
 * ## The four classes, and why each period is the number it is
 *
 * **`financial` — 1825 days (5 years).** Deposits, withdrawals, transfers, conversions, trades,
 * listings, token deployments, wallet and treasury movements, and billing. The basis is a **legal
 * obligation**, not the product promise: AML/CTF record-keeping requires the transaction record to
 * survive five years, and a platform that moves crypto is squarely inside it. This is the one class
 * whose period this service is not free to shorten on product grounds, and it is deliberately the
 * period that applies whatever a record's `visibility` says — an internal reconciliation or a
 * treasury sweep is a financial record about customer funds, and who may read it in the product has
 * no bearing on how long the obligation to hold it runs.
 *
 * **`personal` — 730 days (2 years).** Account, security, ownership, reward, community, governance
 * and API records. Two bases land on the same number and both are stated rather than one being
 * quietly borrowed for the other: the **product promise** of a durable timeline, and a **legitimate
 * interest** in being able to reconstruct an account takeover — a compromise found late is found
 * within months, not years, and a session history from three years ago answers no question anybody
 * is asking. Two years is the point past which neither basis still supports holding the row.
 *
 * **`operational` — 400 days (13 months).** Records with no owner at all and no financial content:
 * a ward opening, a season sealing, a title registration. The basis is a legitimate interest in
 * operating the platform, and thirteen months is a full year of comparisons plus the month it takes
 * to close one. Most of these rows are not personal data in the first place; they are bounded here
 * because a table with one unbounded class has an unbounded table.
 *
 * **`quarantine` — 90 days.** Everything in `unclassified`. This is the shortest period and the
 * only one that is also a **forcing function**. The quarantine exists so an event on a topic this
 * build predates is filed rather than dropped, and so the row can be reclassified when the
 * classifier arrives. That purpose has a shelf life: ninety days is long enough to notice the
 * `activity_unclassified_total` gauge and ship a classifier, and short enough that a topic nobody
 * ever classified does not become a permanent store of a payload nobody has ever read. It is the
 * same discipline `identity/src/topics.ts` states for its own quarantine — "the quarantine empties
 * itself rather than rotting into a permanent allow-list" — applied to rows instead of topics.
 *
 * ## Measured from `recorded_at`, not `occurred_at`
 *
 * Storage limitation asks how long *this service has held the data*, and `recorded_at` is the only
 * timestamp here that answers that. `occurred_at` is supplied by the producer: a clock skew, a
 * backfill, or a relay stuck for a week would move a row's deletion date by a value this service
 * does not control, in either direction. A producer must not be able to shorten another service's
 * retention period by mis-stating a date, and it must not be able to extend it either.
 *
 * ## Where this is enforced, and what survives the enforcement breaking
 *
 * Three places, deliberately, because the first two are the ones that stop working silently:
 *
 *   1. `jobs.ts` runs `activity.records.prune` as a leased recurring job — rule 8, the same
 *      mechanism as the inbox prune, never a `setInterval`. This is what actually deletes.
 *   2. `env.ts` reads each period as a bounded integer whose **maximum is the default**. A
 *      deployment may shorten a period for a stricter jurisdiction; it cannot lengthen one. So the
 *      numbers below are an upper bound on what any deployment retains, rather than a suggestion.
 *   3. Migration 4 puts `retention_class` in the schema, assigned by a **trigger** rather than by
 *      this process, `NOT NULL`, CHECK-constrained to these four values, and — because the table's
 *      immutability trigger refuses UPDATE — unchangeable afterwards. Postgres cannot delete rows
 *      on a schedule of its own, so what the schema can guarantee is not the deletion; it is that
 *      **every row carries the obligation, that no row can be inserted without one, and that
 *      "which rows are overdue" stays answerable by one query on a day the job has not run for a
 *      month.** That query is the `activity_records_retention` view, and `index.ts` scrapes it into
 *      `activity_retention_overdue_total`, which is the alarm for the job having died.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { UNCLASSIFIED, type Category } from './categories.ts'

/** The four classes. Ordered as the precedence rules below apply them. */
export const RETENTION_CLASSES = Object.freeze([
  'quarantine',
  'financial',
  'operational',
  'personal',
] as const)

export type RetentionClass = (typeof RETENTION_CLASSES)[number]

/**
 * The categories whose retention is a legal obligation rather than a product decision.
 *
 * `wallet` is in the list and it is the entry worth defending: a wallet creation is not itself a
 * payment, but a sweep and a reconciliation both file under `wallet` and both are movements of
 * customer funds. Splitting the category to hold two periods would put the two records an
 * investigator reads together on two different expiry dates.
 */
export const FINANCIAL_CATEGORIES: readonly Category[] = Object.freeze([
  'wallet',
  'deposit',
  'withdrawal',
  'transfer',
  'conversion',
  'token',
  'trading',
  'market',
  'billing',
])

/**
 * The rest of the sixteen. Declared explicitly rather than derived as "not financial", so that a
 * seventeenth category has to be placed by a person: the test below asserts the two lists are
 * exactly `CATEGORIES`, which fails on the day one is added and not on the day somebody notices.
 */
export const PERSONAL_CATEGORIES: readonly Category[] = Object.freeze([
  'account',
  'security',
  'ownership',
  'reward',
  'community',
  'governance',
  'api',
])

/** Days, by class. Also the MAXIMUM `env.ts` will accept — see the header. */
export const RETENTION_DAYS: Readonly<Record<RetentionClass, number>> = Object.freeze({
  quarantine: 90,
  financial: 1_825,
  operational: 400,
  personal: 730,
})

/**
 * Which class a record falls in, in precedence order.
 *
 *   1. `unclassified` is quarantine, whatever else it looks like. Nobody has read that payload.
 *   2. A financial category is financial even when the record is internal — the AML obligation is
 *      about the money, not about who may see the row in a feed.
 *   3. An internal record with no financial content is operational.
 *   4. Everything else is a person's own timeline.
 *
 * The authority for this is the trigger installed by migration 4; this function is the same rules
 * in TypeScript so a test can assert the two agree without a database, and so a reader has one
 * place to look. `retention.test` pins them against each other row by row.
 */
export function retentionClassFor(category: string, visibility: string): RetentionClass {
  if (category === UNCLASSIFIED) return 'quarantine'
  if ((FINANCIAL_CATEGORIES as readonly string[]).includes(category)) return 'financial'
  if (visibility === 'internal') return 'operational'
  return 'personal'
}

/** Rendered into migration 4, so the SQL and the lists above cannot drift. */
export function retentionClassSql(column = 'category', visibility = 'visibility'): string {
  const financial = FINANCIAL_CATEGORIES.map((category) => `'${category}'`).join(', ')
  return `case
        when ${column} = '${UNCLASSIFIED}' then 'quarantine'
        when ${column} in (${financial}) then 'financial'
        when ${visibility} = 'internal' then 'operational'
        else 'personal'
      end`
}
