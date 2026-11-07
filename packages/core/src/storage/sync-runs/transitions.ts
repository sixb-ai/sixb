import type { FinishSyncRunInput, SyncRunStatus } from "./types"

/**
 * A run succeeds from `running`. One that never started can fail, its job not published
 * (`queue.enqueue_failed`) or ended before starting it, or end `cancelled`, lost for too long.
 */
export function canFinishSyncRun(status: SyncRunStatus, input: FinishSyncRunInput): boolean {
  if (input.status === "succeeded") return status === "running"
  if (input.status === "failed" && input.error.code === "queue.enqueue_failed") {
    return status === "queued"
  }

  return status === "queued" || status === "running"
}
