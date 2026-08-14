import type { ExecutionStorage } from "../executions"
import { findPrimitiveRunExecution } from "../executions/run-link"
import { WorkflowRunError } from "./errors"

/** Validate the semantic link between a durable workflow run and its immutable execution. */

export async function assertWorkflowRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly workflowId: string
}): Promise<void> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: { kind: "workflow", id: input.workflowId, runId: input.runId },
    sourceTypes: ["execution", "schedule", "event"],
  })
  if (!execution) {
    invalidExecution(input.executionId, input.runId)
  }

  if (execution.source.type === "schedule" || execution.source.type === "event") {
    if (execution.requestedBy !== undefined) {
      invalidExecution(input.executionId, input.runId)
    }
    return
  }

  // ExecutionStorage already validates the immutable parent reference, correlation id, and
  // requested-by propagation. This boundary only owns the workflow-specific source restriction.
  if (execution.source.type !== "execution") {
    invalidExecution(input.executionId, input.runId)
  }
}

function invalidExecution(executionId: string, runId: string): never {
  throw new WorkflowRunError(
    `[Sixb] Execution '${executionId}' does not authorize workflow run '${runId}'.`
  )
}
