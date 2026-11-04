import type { FinishPipelineRunInput, PipelineRunStatus } from "./types"

/**
 * A run finishes from `running`. One that never started can only fail: its job could not be
 * published (`queue.enqueue_failed`), or the job ended before starting it.
 */
export function canFinishPipelineRun(
  status: PipelineRunStatus,
  input: FinishPipelineRunInput
): boolean {
  if (input.status !== "failed") return status === "running"
  if (input.error.code === "queue.enqueue_failed") return status === "queued"
  return status === "queued" || status === "running"
}
