import type { TrustedPrimitiveRef } from "../execution"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution chain required by a workflow-run storage fixture. */
export async function createTestWorkflowExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly workflowId: string
    readonly runId: string
    readonly executionId?: string
  }
): Promise<string> {
  const parentExecutionId = `test_request_execution:${input.runId}`
  const executionId = input.executionId ?? `test_workflow_execution:${input.runId}`
  const primitive: TrustedPrimitiveRef = {
    kind: "workflow",
    id: input.workflowId,
    runId: input.runId,
  }

  await executions.create({
    id: parentExecutionId,
    projectId: input.projectId,
    executor: { type: "request", requestId: `test_request:${input.runId}` },
    source: { type: "http", requestId: `test_request:${input.runId}` },
    correlationId: `test_correlation:${input.runId}`,
    authorizationRef: { type: "disabled" },
  })
  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "execution", executionId: parentExecutionId },
    correlationId: `test_correlation:${input.runId}`,
    parentExecutionId,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })

  return executionId
}

/** Create a root workflow execution as produced by an automatic trigger. */
export async function createTestAutomaticWorkflowExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly workflowId: string
    readonly runId: string
    readonly executionId?: string
    readonly source?: { readonly type: "schedule" | "event"; readonly eventId: string }
    readonly correlationId?: string
  }
): Promise<string> {
  const executionId = input.executionId ?? `test_workflow_execution:${input.runId}`
  const primitive: TrustedPrimitiveRef = {
    kind: "workflow",
    id: input.workflowId,
    runId: input.runId,
  }

  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: input.source ?? { type: "event", eventId: `test_event:${input.runId}` },
    correlationId: input.correlationId ?? `test_correlation:${input.runId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })

  return executionId
}
