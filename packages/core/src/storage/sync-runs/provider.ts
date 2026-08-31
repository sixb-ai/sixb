import type { ExecutionStorage } from "../executions"
import { findPrimitiveRunExecution } from "../executions/run-link"
import { SyncRunError } from "./errors"

/** Validate the semantic link between a durable Sync run and its immutable execution. */
export async function assertSyncRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly syncId: string
}): Promise<void> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: { kind: "sync", id: input.syncId, runId: input.runId },
    sourceTypes: ["execution", "schedule", "event"],
  })
  if (!execution) {
    throw new SyncRunError(
      `[Sixb] Execution '${input.executionId}' does not authorize Sync run '${input.runId}'.`
    )
  }
}
