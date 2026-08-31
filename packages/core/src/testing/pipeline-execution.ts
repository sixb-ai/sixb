import type { TrustedPrimitiveRef } from "../execution"
import type { PipelineRunRecord, QueuePipelineRunInput, Storage } from "../storage"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution required by a Pipeline-run storage fixture. */
export async function createTestPipelineExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly pipelineId: string
    readonly runId: string
    readonly executionId?: string
  }
): Promise<string> {
  const executionId = input.executionId ?? `test_pipeline_execution:${input.runId}`
  const existing = await executions.getById({ projectId: input.projectId, id: executionId })
  if (existing) return executionId

  const primitive: TrustedPrimitiveRef = {
    kind: "pipeline",
    id: input.pipelineId,
    runId: input.runId,
  }
  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "event", eventId: `test_event:${input.runId}` },
    correlationId: `test_correlation:${input.runId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })
  return executionId
}

/** Queue a Pipeline run with the valid durable execution fixture required by every provider. */
export async function queueTestPipelineRun(
  storage: Pick<Storage, "pipelineRuns" | "executions">,
  input: Omit<QueuePipelineRunInput, "executionId">
): Promise<PipelineRunRecord> {
  if (!storage.pipelineRuns)
    throw new Error("Pipeline run storage is not configured for this test.")
  const executionId = await createTestPipelineExecution(storage.executions, {
    projectId: input.projectId,
    pipelineId: input.pipelineId,
    runId: input.id,
  })
  return storage.pipelineRuns.queue({ ...input, executionId })
}

/** Start a Pipeline run after creating its durable execution and queued state. */
export async function startTestPipelineRun(
  storage: Pick<Storage, "pipelineRuns" | "executions">,
  input: Omit<QueuePipelineRunInput, "executionId" | "queuedAt"> & {
    readonly startedAt?: Date
  }
): Promise<PipelineRunRecord> {
  const { startedAt, ...queuedRun } = input
  await queueTestPipelineRun(storage, { ...queuedRun, queuedAt: startedAt })
  return storage.pipelineRuns!.start({
    id: input.id,
    projectId: input.projectId,
    startedAt,
  })
}
