/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and adding one fails review — the estate
 * runs eight of them today, each guarded only by a module-local boolean, which is a variable that
 * by construction cannot be seen by a second process.
 *
 * **The lease key names the contended resource, not the row.** The inbox prune is an estate-wide
 * sweep over one table, so it keys on `global`: what would break if two ran at once is that they
 * would delete each other's rows and each report a count that is wrong.
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { RETENTION_CLASSES, type RetentionClass } from './retention.ts'
import type { Db } from './records.ts'

export const INBOX_PRUNE_KIND = 'activity.inbox.prune'
export const RECORD_PRUNE_KIND = 'activity.records.prune'

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer here is the boot
 * seed below plus the reschedule on completion — so the interval survives a restart, is visible
 * in a table an operator can query, and is claimed by exactly one replica.
 */
export const RECURRING: ReadonlyArray<{ kind: string; key: string; everyMs: number }> = [
  { kind: INBOX_PRUNE_KIND, key: 'global', everyMs: 3_600_000 },
  // Six-hourly. The periods are measured in hundreds of days, so the interval is not about
  // precision — it is about the job running often enough that a failure shows up in
  // `jobs_overdue` within a working day rather than at the end of a month.
  { kind: RECORD_PRUNE_KIND, key: 'global', everyMs: 21_600_000 },
]

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKind = new Map(RECURRING.map((r) => [r.kind, r]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind ? byKind.get(event.kind) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly inboxRetentionDays: number
  /** Days, by retention class. `env.ts` may only shorten these — see `src/retention.ts`. */
  readonly retentionDays: Readonly<Record<RetentionClass, number>>
}

/**
 * Rows deleted per statement, and passes per run.
 *
 * A single unqualified `DELETE` over an expired backlog would take one long lock on the table every
 * feed read and every ingest has to queue behind — which is how a retention job becomes an
 * incident and then becomes a job somebody turns off. Batching keeps each statement short; the cap
 * keeps one run bounded, and the six-hourly reschedule is what eventually clears a large backlog.
 * 100 × 1000 is 100,000 rows a run, 400,000 a day, which drains any backlog this service can
 * plausibly have accumulated inside a week.
 */
const PRUNE_BATCH = 1_000
const PRUNE_PASSES = 100

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  /**
   * Drop inbox rows older than every producer's retry horizon.
   *
   * The retention floor is what makes this safe: prune a row while its producer could still
   * redeliver, and the redelivery is processed as new. It would then hit the unique constraint on
   * `source_event_id` and be dropped anyway — which is exactly why that constraint is there and
   * not only in the application. Belt and braces, and the braces are in the schema.
   */
  runner.register(INBOX_PRUNE_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const rows = await deps.sql<{ n: number }[]>`
      delete from inbox
       where received_at < now() - make_interval(days => ${deps.inboxRetentionDays})
      returning 1 as n
    `
    if (rows.length > 0) deps.logger.info('inbox prune', { removed: rows.length })
  })

  /**
   * **STORAGE LIMITATION, EXECUTED.** The half of `src/retention.ts` that actually deletes.
   *
   * There was no such job before this one. The service described its records as "a permanent,
   * itemised narrative", the only recurring work pruned the *inbox*, and the sole DELETE against
   * `activity_records` was erasure — so every period this estate might have intended was a
   * documented intention nothing executed, which is the "check that cannot fail" pattern with a
   * compliance hat on. A period is enforced or it is prose.
   *
   * Four statements rather than one, keyed on `retention_class`, because the four periods are four
   * different lawful bases and collapsing them into one number would mean writing down a basis for
   * a period nothing corresponds to. The class is the DATABASE's answer (a trigger assigns it, and
   * the immutability trigger stops anything changing it afterwards), so this job cannot delete a
   * row under a period the row was not admitted under.
   *
   * `recorded_at`, never `occurred_at` — see the header of `src/retention.ts`. A producer must not
   * be able to move another service's deletion date by mis-stating a timestamp.
   */
  runner.register(RECORD_PRUNE_KIND, async (_job, ctx) => {
    const removed: Partial<Record<RetentionClass, number>> = {}
    for (const retentionClass of RETENTION_CLASSES) {
      const days = deps.retentionDays[retentionClass]
      let total = 0
      for (let pass = 0; pass < PRUNE_PASSES; pass += 1) {
        // A drain must be able to stop this mid-backlog: the lease is held for the whole run, and
        // a hundred passes of a thousand rows is not instant.
        if (ctx.signal.aborted) break
        // `returning 1`, as the inbox prune does: the count is the whole of what this needs, and
        // there is no reason to pull a thousand record ids per batch into this process to count
        // them. Batched by `ctid`, which is the cheapest possible handle on "some thousand rows
        // matching this predicate" — the job holds the only lease, so nothing else is moving them.
        const rows = await deps.sql<{ n: number }[]>`
          delete from activity_records
           where ctid in (
                 select ctid
                   from activity_records
                  where retention_class = ${retentionClass}
                    and recorded_at < now() - make_interval(days => ${days})
                  limit ${PRUNE_BATCH}
                 )
          returning 1 as n
        `
        total += rows.length
        if (rows.length < PRUNE_BATCH) break
      }
      if (total > 0) {
        removed[retentionClass] = total
        deps.metrics.increment('activity_records_pruned_total', { class: retentionClass }, total)
      }
    }
    // Counts and class names. Never a record, never a field of one — this is the log line an
    // operator reads to see the job did something, and it is the answer to "how do I observe it".
    if (Object.keys(removed).length > 0) deps.logger.info('record retention prune', { removed })
  })

  return runner
}
