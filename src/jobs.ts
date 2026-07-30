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
import type { Logger } from '@cloudsforge/telemetry'
import type { Db } from './records.ts'

export const INBOX_PRUNE_KIND = 'activity.inbox.prune'

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer here is the boot
 * seed below plus the reschedule on completion — so the interval survives a restart, is visible
 * in a table an operator can query, and is claimed by exactly one replica.
 */
export const RECURRING: ReadonlyArray<{ kind: string; key: string; everyMs: number }> = [
  { kind: INBOX_PRUNE_KIND, key: 'global', everyMs: 3_600_000 },
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
  readonly inboxRetentionDays: number
}

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

  return runner
}
