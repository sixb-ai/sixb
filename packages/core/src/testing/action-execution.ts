import type { AuthorizablePrincipal, TrustedPrimitiveRef } from "../execution"
import type { ActionRunRecord, QueueActionRunInput, Storage } from "../storage"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution chain required by an Action-run storage fixture. */
export async function createTestActionExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly actionId: string
    readonly runId: string
    readonly executionId?: string
    readonly requesterGroupIds?: readonly string[]
    /** Must name an existing auth principal. The parent request then carries its authority. */
    readonly requestedBy?: AuthorizablePrincipal
  }
): Promise<string> {
  const parentExecutionId = `test_request_execution:${input.runId}`
  const executionId = input.executionId ?? `test_action_execution:${input.runId}`
  const primitive: TrustedPrimitiveRef = {
    kind: "action",
    id: input.actionId,
    runId: input.runId,
  }

  const existing = await executions.getById({ projectId: input.projectId, id: executionId })
  if (existing) return executionId

  const requestedBy = input.requestedBy
  const parent = await executions.getById({ projectId: input.projectId, id: parentExecutionId })
  if (!parent) {
    await executions.create({
      id: parentExecutionId,
      requesterGroupIds: input.requesterGroupIds ?? [],
      projectId: input.projectId,
      ...(requestedBy === undefined ? {} : { requestedBy }),
      executor: { type: "request", requestId: `test_request:${input.runId}` },
      source: { type: "http", requestId: `test_request:${input.runId}` },
      correlationId: `test_correlation:${input.runId}`,
      authorizationRef:
        requestedBy === undefined
          ? { type: "disabled" }
          : { type: "principal", principal: requestedBy },
    })
  }
  await executions.create({
    id: executionId,
    requesterGroupIds: input.requesterGroupIds ?? [],
    projectId: input.projectId,
    ...(requestedBy === undefined ? {} : { requestedBy }),
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "execution", executionId: parentExecutionId },
    correlationId: `test_correlation:${input.runId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })

  return executionId
}

/** Queue an Action run with the valid durable execution fixture required by every provider. */
export async function queueTestActionRun(
  storage: Pick<Storage, "actionRuns" | "executions">,
  input: Omit<QueueActionRunInput, "executionId"> & {
    readonly requesterGroupIds?: readonly string[]
    readonly requestedBy?: AuthorizablePrincipal
  }
): Promise<ActionRunRecord> {
  if (!storage.actionRuns) throw new Error("Action run storage is not configured for this test.")
  const executionId = await createTestActionExecution(storage.executions, {
    projectId: input.projectId,
    actionId: input.actionId,
    runId: input.id,
    requesterGroupIds: input.requesterGroupIds,
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
  })
  const { requesterGroupIds: _groups, requestedBy: _requestedBy, ...run } = input
  return storage.actionRuns.queue({ ...run, executionId })
}
