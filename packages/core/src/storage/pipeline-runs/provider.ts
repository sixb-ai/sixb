import type { ExecutionStorage } from "../executions"
import { findPrimitiveRunExecution } from "../executions/run-link"
import { PipelineRunError } from "./errors"

/** Validate the semantic link between a durable Pipeline run and its immutable execution. */
export async function assertPipelineRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly pipelineId: string
}): Promise<void> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: { kind: "pipeline", id: input.pipelineId, runId: input.runId },
    sourceTypes: ["execution", "schedule", "event"],
  })
  if (!execution) {
    throw new PipelineRunError(
      `[Sixb] Execution '${input.executionId}' does not authorize Pipeline run '${input.runId}'.`
    )
  }
}
