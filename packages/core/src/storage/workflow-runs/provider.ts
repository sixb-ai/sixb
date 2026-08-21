import { agentServiceAccountId } from "../../agents/authority"
import type { ExecutionStorage } from "../executions"
import { findAgentRunExecution, findPrimitiveRunExecution } from "../executions/run-link"
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

/** Validate the semantic link between a Workflow Agent-node run and its child execution. */
export async function assertWorkflowAgentNodeRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly nodeRunId: string
  readonly agentId: string
  readonly workflowExecutionId: string
}): Promise<void> {
  const execution = await findAgentRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    runId: input.nodeRunId,
    serviceAccountId: agentServiceAccountId(input.agentId),
  })
  if (
    !execution ||
    execution.source.type !== "execution" ||
    execution.source.executionId !== input.workflowExecutionId
  ) {
    throw new WorkflowRunError(
      `[Sixb] Execution '${input.executionId}' does not authorize Workflow Agent-node run '${input.nodeRunId}'.`
    )
  }
}

function invalidExecution(executionId: string, runId: string): never {
  throw new WorkflowRunError(
    `[Sixb] Execution '${executionId}' does not authorize workflow run '${runId}'.`
  )
}
