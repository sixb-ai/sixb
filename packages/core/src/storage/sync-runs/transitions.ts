import type { FinishSyncRunInput, SyncRunStatus } from "./types"

/**
 * A run finishes from `running`. One that never started can only fail: its job could not be
 * published (`queue.enqueue_failed`), or the job ended before starting it.
 */
export function canFinishSyncRun(status: SyncRunStatus, input: FinishSyncRunInput): boolean {
  if (input.status !== "failed") return status === "running"
  if (input.error.code === "queue.enqueue_failed") return status === "queued"
  return status === "queued" || status === "running"
}
