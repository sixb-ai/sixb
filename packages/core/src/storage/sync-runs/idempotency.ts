import type { QueueSyncRunInput, SyncRunRecord } from "./types"

export function canRequeueSyncRunAfterEnqueueFailure(
  existing: SyncRunRecord,
  input: QueueSyncRunInput
): boolean {
  return (
    existing.status === "failed" &&
    existing.error?.code === "queue.enqueue_failed" &&
    existing.error.retryable &&
    existing.executionId === input.executionId &&
    existing.syncId === input.syncId &&
    existing.datasetId === input.datasetId &&
    existing.mode === input.mode &&
    existing.expectedLatestVersionId === input.expectedLatestVersionId &&
    existing.commitMessage === input.commitMessage
  )
}
