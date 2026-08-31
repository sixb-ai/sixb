import type { TrustedPrimitiveRef } from "../execution"
import type { QueueSyncRunInput, Storage, SyncRunRecord } from "../storage"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution required by a Sync-run storage fixture. */
export async function createTestSyncExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly syncId: string
    readonly runId: string
    readonly executionId?: string
  }
): Promise<string> {
  const executionId = input.executionId ?? `test_sync_execution:${input.runId}`
  const existing = await executions.getById({ projectId: input.projectId, id: executionId })
  if (existing) return executionId

  const primitive: TrustedPrimitiveRef = {
    kind: "sync",
    id: input.syncId,
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

/** Queue a Sync run with the valid durable execution fixture required by every provider. */
export async function queueTestSyncRun(
  storage: Pick<Storage, "syncRuns" | "executions">,
  input: Omit<QueueSyncRunInput, "executionId">
): Promise<SyncRunRecord> {
  if (!storage.syncRuns) throw new Error("Sync run storage is not configured for this test.")
  const executionId = await createTestSyncExecution(storage.executions, {
    projectId: input.projectId,
    syncId: input.syncId,
    runId: input.id,
  })
  return storage.syncRuns.queue({ ...input, executionId })
}

/** Start a Sync run after creating its durable execution and queued state. */
export async function startTestSyncRun(
  storage: Pick<Storage, "syncRuns" | "executions">,
  input: Omit<QueueSyncRunInput, "executionId" | "queuedAt"> & { readonly startedAt?: Date }
): Promise<SyncRunRecord> {
  const { startedAt, ...queuedRun } = input
  await queueTestSyncRun(storage, { ...queuedRun, queuedAt: startedAt })
  return storage.syncRuns!.start({
    id: input.id,
    projectId: input.projectId,
    startedAt,
  })
}
