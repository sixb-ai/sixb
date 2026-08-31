import type { PipelineRunRecord, QueuePipelineRunInput } from "./types"

export function canRequeuePipelineRunAfterEnqueueFailure(
  existing: PipelineRunRecord,
  input: QueuePipelineRunInput
): boolean {
  return (
    existing.status === "failed" &&
    existing.error?.code === "queue.enqueue_failed" &&
    existing.error.retryable &&
    existing.executionId === input.executionId &&
    existing.pipelineId === input.pipelineId
  )
}
