import type { Queues } from "../queues"
import type { MaintenancePass } from "./loop"

export const LAKE_RETENTION_PASS_ID = "lake-retention"

/** A request is one write. Past this it hangs: count it as failed. */
const REQUEST_BUDGET_MS = 30_000

/** A request that failed is tried again this soon, rather than one whole interval later. */
const REQUEST_RETRY_MS = 60_000

export interface LakeRetentionPassInput {
  readonly projectId: string
  readonly cleanupEveryMs: number
  readonly queue: Pick<Queues["lake"], "enqueue">
}

/**
 * Asks a lake worker for retention once per interval, at the interval's start and on the first run.
 * Intervals are counted from the epoch and name the job, so a restart or a second orchestrator
 * requests nothing more while the queue remembers that job.
 */
export function lakeRetentionPass(input: LakeRetentionPassInput): MaintenancePass {
  const { projectId, cleanupEveryMs, queue } = input
  let requested: number | null = null

  const intervalOf = (time: Date): number =>
    Math.floor(time.getTime() / cleanupEveryMs) * cleanupEveryMs

  return {
    id: LAKE_RETENTION_PASS_ID,
    budgetMs: REQUEST_BUDGET_MS,

    nextRunAt(now, lastFinishedAt) {
      if (requested === intervalOf(now)) return new Date(requested + cleanupEveryMs)
      if (lastFinishedAt === null) return now

      return new Date(lastFinishedAt.getTime() + REQUEST_RETRY_MS)
    },

    async run() {
      const interval = intervalOf(new Date())
      const requestedAt = new Date(interval).toISOString()

      await queue.enqueue({
        projectId,
        jobs: [
          {
            id: `lake-retention:${requestedAt}`,
            type: "lake.retention.requested",
            payload: { requestedAt },
          },
        ],
      })

      requested = interval
    },
  }
}
