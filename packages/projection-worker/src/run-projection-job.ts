import {
  isMaterializationConflictError,
  MaterializationCancellationError,
  MaterializationValidationError,
  type ProjectionDefinition,
} from "@sixb/core"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { ProjectionRunObjectTypes, ProjectionRunRecord } from "@sixb/core/storage"
import { ProjectionWorkerPermanentError } from "./errors"
import {
  assertProjectionJobId,
  type ValidatedProjectionJob,
  validateProjectionJob,
} from "./job-validation"
import { mapLinkProjectionEntries } from "./run-link-projection"
import { mapObjectProjectionEntries } from "./run-object-projection"
import { runTelemetryProjection, TELEMETRY_PROJECTION_BATCH_SIZE } from "./run-telemetry-projection"
import type {
  ClaimedProjectionExecution,
  ProjectionJob,
  ProjectionJobResult,
  RunProjectionJobInput,
} from "./types"

export async function runProjectionJob(input: RunProjectionJobInput): Promise<ProjectionJobResult> {
  const signal = input.signal ?? new AbortController().signal
  assertProjectionJobId(input.runtime.projectId, input.job)
  const terminal = await findMatchingTerminalRun(input)
  if (terminal) return terminalResult(terminal)

  const validated = await validateProjectionJob(input.runtime, input.job)
  const execution = await claimOrReplaySucceededRun(input, validated.objectTypes)
  if ("replayedTerminal" in execution) return execution
  try {
    await materializeProjection(input, validated, execution, signal)
    await finishProjection(input, execution, "succeeded")
    return { run: await requireRun(input), replayedTerminal: false }
  } catch (error) {
    const succeeded = await findSucceededRun(input)
    if (succeeded) return terminalResult(succeeded)

    if (isExplicitCancellation(error)) {
      await finishProjection(input, execution, "cancelled", error.message)
      throw error
    }
    if (isPermanentFailure(error) && !signal.aborted) {
      await finishProjection(input, execution, "failed", errorMessage(error))
      const run = await requireRun(input)
      input.onRunFailed?.(error, run)
    }
    // Transient errors, delivery loss, shutdown, and stale executions deliberately leave the run
    // running so the next QueueDelivery can reclaim it with a fresh token.
    throw error
  }
}

async function claimOrReplaySucceededRun(
  input: RunProjectionJobInput,
  objectTypes: ProjectionRunObjectTypes
): Promise<ClaimedProjectionExecution | ProjectionJobResult> {
  try {
    return await claimExecution(input, objectTypes)
  } catch (error) {
    // Another delivery may have finished after our initial terminal read but before the claim.
    const succeeded = await findSucceededRun(input)
    if (succeeded) return terminalResult(succeeded)
    throw error
  }
}

async function findMatchingTerminalRun(
  input: RunProjectionJobInput
): Promise<ProjectionRunRecord | null> {
  const run = await input.runtime.projectionRunsStorage.getById({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  if (!run) return null
  assertRunMatchesJob(run, input.job)
  if (run.status === "running") return null
  if (run.status === "succeeded") return run
  throw new ProjectionWorkerPermanentError(
    `[SixbProjectionWorker] Projection run '${run.id}' is already '${run.status}'.`
  )
}

async function claimExecution(
  input: RunProjectionJobInput,
  objectTypes: ProjectionRunObjectTypes
): Promise<ClaimedProjectionExecution> {
  const fixedBatchSize = telemetryBatchSize(input)
  const run = await input.runtime.projectionRunsStorage.startOrReclaimMaterialization({
    projectId: input.runtime.projectId,
    id: input.job.id,
    identity: input.job,
    ...objectTypes,
    ...(fixedBatchSize === undefined ? {} : { fixedBatchSize }),
  })
  return {
    run,
    identity: input.job,
    execution: { projectionRunId: run.id, executionToken: run.executionToken },
  }
}

function telemetryBatchSize(input: RunProjectionJobInput): number | undefined {
  if (input.job.protocol !== "telemetry") return undefined
  return input.telemetryBatchSize ?? TELEMETRY_PROJECTION_BATCH_SIZE
}

async function materializeProjection(
  input: RunProjectionJobInput,
  validated: ValidatedProjectionJob,
  execution: ClaimedProjectionExecution,
  signal: AbortSignal
): Promise<void> {
  const { projection, dataset } = validated
  if (projection._tag === "TelemetryProjectionDefinition") {
    await runTelemetryProjection({
      runtime: input.runtime,
      projection,
      dataset,
      execution,
      signal,
    })
    return
  }

  const entries = replacementEntries(input, projection, dataset, execution, signal)
  await getOntologyMutationRuntime(input.runtime).replaceProjection({
    source: { projectionId: projection.id },
    datasetVersion: input.job.datasetVersion,
    execution: execution.execution,
    entries,
    signal,
  })
}

function replacementEntries(
  input: RunProjectionJobInput,
  projection: Exclude<ProjectionDefinition, { readonly _tag: "TelemetryProjectionDefinition" }>,
  dataset: ValidatedProjectionJob["dataset"],
  execution: ClaimedProjectionExecution,
  signal: AbortSignal
) {
  if (projection._tag === "ObjectProjectionDefinition") {
    return mapObjectProjectionEntries({
      runtime: input.runtime,
      projection,
      dataset,
      execution,
      signal,
    })
  }
  return mapLinkProjectionEntries({
    runtime: input.runtime,
    projection,
    dataset,
    execution,
    signal,
  })
}

async function finishProjection(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  status: "succeeded" | "failed" | "cancelled",
  errorMessage?: string
): Promise<void> {
  const common = {
    source: { projectionId: input.job.projectionId },
    datasetVersion: input.job.datasetVersion,
    execution: execution.execution,
  }
  const mutations = getOntologyMutationRuntime(input.runtime)
  if (input.job.protocol === "replacement") {
    await mutations.finishProjection({
      ...common,
      protocol: "replacement",
      status,
      ...(status === "succeeded" ? {} : { errorMessage }),
    })
    return
  }
  if (status === "succeeded") {
    await mutations.finishProjection({
      ...common,
      protocol: "telemetry",
      status: "succeeded",
      inputExhausted: true,
    })
    return
  }
  await mutations.finishProjection({
    ...common,
    protocol: "telemetry",
    status,
    errorMessage,
  })
}

async function findSucceededRun(input: RunProjectionJobInput): Promise<ProjectionRunRecord | null> {
  try {
    const run = await input.runtime.projectionRunsStorage.getById({
      projectId: input.runtime.projectId,
      id: input.job.id,
    })
    return run?.status === "succeeded" ? run : null
  } catch {
    return null
  }
}

async function requireRun(input: RunProjectionJobInput): Promise<ProjectionRunRecord> {
  const run = await input.runtime.projectionRunsStorage.getById({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  if (run) return run
  throw new Error(`[SixbProjectionWorker] Projection run '${input.job.id}' disappeared.`)
}

function assertRunMatchesJob(run: ProjectionRunRecord, job: ProjectionJob): void {
  const matches =
    run.projectionId === job.projectionId &&
    run.projectionKind === job.projectionKind &&
    run.materializationProtocol === job.protocol &&
    run.datasetId === job.datasetVersion.datasetId &&
    run.datasetVersionId === job.datasetVersion.versionId &&
    run.datasetVersionCreatedAt === job.datasetVersion.createdAt &&
    run.ontologyRevision === job.ontologyRevision &&
    run.projectionRevision === job.projectionRevision &&
    run.ownershipHash === job.ownershipHash
  if (matches) return
  throw new ProjectionWorkerPermanentError(
    `[SixbProjectionWorker] Projection run '${run.id}' has a different durable identity.`
  )
}

function terminalResult(run: ProjectionRunRecord): ProjectionJobResult {
  return { run, replayedTerminal: true }
}

function isPermanentFailure(error: unknown): boolean {
  if (
    error instanceof ProjectionWorkerPermanentError ||
    error instanceof MaterializationValidationError
  ) {
    return true
  }
  if (!isMaterializationConflictError(error)) return false
  return (
    error.kind === "idempotency" ||
    error.kind === "projection-fence" ||
    error.kind === "run-correlation"
  )
}

function isExplicitCancellation(error: unknown): error is MaterializationCancellationError {
  return error instanceof MaterializationCancellationError
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isPermanentProjectionFailure(error: unknown): boolean {
  return isPermanentFailure(error) || isExplicitCancellation(error)
}
