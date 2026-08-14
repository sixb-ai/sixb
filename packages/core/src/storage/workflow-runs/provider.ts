import type { ExecutionStorage } from "../executions"
import { WorkflowRunError } from "./errors"

/** Validate the semantic link between a durable workflow run and its immutable execution. */

export async function assertWorkflowRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly workflowId: string
}): Promise<void> {
  const execution = await input.executions.getById({
    projectId: input.projectId,
    id: input.executionId,
  })
  const authority = execution?.authorizationRef
  if (
    !execution ||
    execution.executor.type !== "primitive" ||
    execution.executor.kind !== "workflow" ||
    execution.executor.runId !== input.runId ||
    authority?.type !== "trustedPrimitive" ||
    authority.primitive.kind !== "workflow" ||
    authority.primitive.id !== input.workflowId ||
    authority.primitive.runId !== input.runId
  ) {
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
