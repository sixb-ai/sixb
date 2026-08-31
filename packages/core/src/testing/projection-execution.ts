import type { TrustedPrimitiveRef } from "../execution"
import type {
  ProjectionRunClaim,
  ProjectionRunRecord,
  QueueProjectionRunInput,
  StartOrReclaimProjectionRunInput,
  Storage,
} from "../storage"
import type { ExecutionStorage } from "../storage/executions"

type ProjectionRunQueueFixtureInput = QueueProjectionRunInput extends infer TInput
  ? TInput extends QueueProjectionRunInput
    ? Omit<TInput, "executionId">
    : never
  : never

/** Create the durable execution required by a Projection-run storage fixture. */
export async function createTestProjectionExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly projectionId: string
    readonly runId: string
    readonly datasetId: string
    readonly datasetVersionId: string
    readonly executionId?: string
  }
): Promise<string> {
  const executionId = input.executionId ?? `test_projection_execution:${input.runId}`
  const existing = await executions.getById({ projectId: input.projectId, id: executionId })
  if (existing) return executionId

  const primitive: TrustedPrimitiveRef = {
    kind: "projection",
    id: input.projectionId,
    runId: input.runId,
  }
  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: {
      type: "datasetVersion",
      datasetId: input.datasetId,
      versionId: input.datasetVersionId,
    },
    correlationId: `test_correlation:${input.runId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })
  return executionId
}

/** Queue a Projection run with the valid durable execution fixture required by every provider. */
export async function queueTestProjectionRun(
  storage: Pick<Storage, "projectionRuns" | "executions">,
  input: ProjectionRunQueueFixtureInput
): Promise<ProjectionRunRecord> {
  if (!storage.projectionRuns)
    throw new Error("Projection run storage is not configured for this test.")
  const executionId = await createTestProjectionExecution(storage.executions, {
    projectId: input.projectId,
    projectionId: input.identity.projectionId,
    runId: input.id,
    datasetId: input.identity.datasetVersion.datasetId,
    datasetVersionId: input.identity.datasetVersion.versionId,
  })
  return storage.projectionRuns.queue({ ...input, executionId })
}

/** Start a Projection run after creating its durable execution and queued state. */
export async function startTestProjectionRun(
  storage: Pick<Storage, "projectionRuns" | "executions">,
  input: StartOrReclaimProjectionRunInput
): Promise<ProjectionRunClaim> {
  const projectionRuns = storage.projectionRuns
  if (!projectionRuns) throw new Error("Projection run storage is not configured for this test.")
  const { startedAt, ...queuedRun } = input
  await queueTestProjectionRun(storage, { ...queuedRun, queuedAt: startedAt })
  return projectionRuns.startOrReclaim(input)
}

/** Claim a queued fixture, or rotate its attempt when the same durable run is reclaimed. */
export async function claimTestProjectionRun(
  storage: Pick<Storage, "projectionRuns" | "executions">,
  input: StartOrReclaimProjectionRunInput
): Promise<ProjectionRunClaim> {
  if (!storage.projectionRuns)
    throw new Error("Projection run storage is not configured for this test.")
  const existing = await storage.projectionRuns.getById({
    projectId: input.projectId,
    id: input.id,
  })
  if (!existing) {
    const { startedAt, ...queuedRun } = input
    await queueTestProjectionRun(storage, { ...queuedRun, queuedAt: startedAt })
  }
  return storage.projectionRuns.startOrReclaim(input)
}
