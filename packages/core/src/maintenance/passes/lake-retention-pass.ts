import type { Queues } from "../../queues"
import type { LakeRetentionStatus } from "../lake-retention-status"
import type { MaintenancePass } from "../loop"

export const LAKE_RETENTION_PASS_ID = "lake-retention"

/** A request is one write. Past this it hangs: count it as failed. */
const REQUEST_BUDGET_MS = 30_000

/** A request that failed is tried again this soon, rather than one whole interval later. */
const REQUEST_RETRY_MS = 60_000

export interface LakeRetentionPassInput {
  readonly projectId: string
  readonly cleanupEveryMs: number
  readonly queue: Pick<Queues["lake"], "enqueue">
  status(): Promise<Pick<LakeRetentionStatus, "state">>
}

/**
 * Asks a lake worker for retention once per interval, at the interval's start and on the first run.
 * Intervals are counted from the epoch and name the job, so a restart or a second orchestrator
 * requests nothing more while the queue remembers that job.
 *
 * A worker list can leave the lake worker out in ways nothing can tell at startup, such as separate
 * `sixb worker <type>` processes, so each request says when the last one went unanswered.
 */
export function lakeRetentionPass(input: LakeRetentionPassInput): MaintenancePass {
  const { projectId, cleanupEveryMs, queue, status } = input
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
      const intervalStart = new Date(interval).toISOString()

      await queue.enqueue({
        projectId,
        jobs: [
          {
            id: `lake-retention:${intervalStart}`,
            type: "lake.retention.requested",
            payload: { intervalStart },
          },
        ],
      })

      requested = interval

      if ((await status()).state === "no-worker") {
        console.warn(
          "[Sixb] Lake cleanup is requested but no lake worker has run it: run `sixb worker lake`, or add `lake` to the worker group."
        )
      }
    },
  }
}
