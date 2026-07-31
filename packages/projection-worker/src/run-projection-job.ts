import {
  isMaterializationConflictError,
  MaterializationCancellationError,
  MaterializationValidationError,
  type ProjectionDefinition,
} from "@sixb/core"
import {
  MaterializationObjectNotFoundError,
  type ProjectionRunTerminalDecision,
} from "@sixb/core/internal/materialization"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { ProjectionRunRecord } from "@sixb/core/storage"
import { ProjectionWorkerPermanentError } from "./errors"
import {
  assertProjectionJobId,
  type ValidatedProjectionJob,
  validateProjectionJob,
} from "./job-validation"
import { MISSING_TARGET_ATTEMPT_BUDGET } from "./retry-backoff"
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
  const execution = await claimOrReplaySucceededRun(input, validated)
  if ("replayedTerminal" in execution) return execution
  try {
    const completion = await materializeProjection(input, validated, execution, signal)
    await finishProjection(input, execution, { ...completion, status: "succeeded" })
    return { run: await requireRun(input), replayedTerminal: false }
  } catch (error) {
    const succeeded = await findSucceededRun(input)
    if (succeeded) return terminalResult(succeeded)

    if (isExplicitCancellation(error)) {
      await finishProjection(input, execution, {
        protocol: input.job.protocol,
        status: "cancelled",
        errorMessage: error.message,
      })
      throw error
    }
    if (isPermanentFailure(error, input.attempt ?? 1) && !signal.aborted) {
      await finishProjection(input, execution, {
        protocol: input.job.protocol,
        status: "failed",
        errorMessage: errorMessage(error),
      })
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
  validated: ValidatedProjectionJob
): Promise<ClaimedProjectionExecution | ProjectionJobResult> {
  try {
    return await claimExecution(input, validated)
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
  validated: ValidatedProjectionJob
): Promise<ClaimedProjectionExecution> {
  const common = { projectId: input.runtime.projectId, id: input.job.id }
  switch (validated.kind) {
    case "object":
      return input.runtime.projectionRunsStorage.startOrReclaim({
        ...common,
        identity: validated.job,
        target: validated.target,
      })
    case "link":
      return input.runtime.projectionRunsStorage.startOrReclaim({
        ...common,
        identity: validated.job,
        target: validated.target,
      })
    case "telemetry":
      return input.runtime.projectionRunsStorage.startOrReclaim({
        ...common,
        identity: validated.job,
        target: validated.target,
        fixedBatchSize: input.telemetryBatchSize ?? TELEMETRY_PROJECTION_BATCH_SIZE,
      })
  }
}

async function materializeProjection(
  input: RunProjectionJobInput,
  validated: ValidatedProjectionJob,
  execution: ClaimedProjectionExecution,
  signal: AbortSignal
): Promise<ProjectionSuccessfulCompletion> {
  switch (validated.kind) {
    case "telemetry":
      return runTelemetryProjection({
        runtime: input.runtime,
        projection: validated.projection,
        dataset: validated.dataset,
        version: validated.version,
        execution,
        signal,
      })
    case "object":
    case "link": {
      const entries = replacementEntries(
        input,
        validated.projection,
        validated.dataset,
        execution,
        validated.version.rowCount,
        signal
      )
      await getOntologyMutationRuntime(input.runtime).replaceProjection({
        source: { projectionId: validated.projection.id },
        datasetVersion: input.job.datasetVersion,
        execution: execution.execution,
        entries,
        signal,
      })
      return { protocol: "replacement" }
    }
  }
}

function replacementEntries(
  input: RunProjectionJobInput,
  projection: Exclude<ProjectionDefinition, { readonly _tag: "TelemetryProjectionDefinition" }>,
  dataset: ValidatedProjectionJob["dataset"],
  execution: ClaimedProjectionExecution,
  expectedRows: number | undefined,
  signal: AbortSignal
) {
  if (projection._tag === "ObjectProjectionDefinition") {
    return mapObjectProjectionEntries({
      runtime: input.runtime,
      projection,
      dataset,
      execution,
      expectedRows,
      signal,
    })
  }
  return mapLinkProjectionEntries({
    runtime: input.runtime,
    projection,
    dataset,
    execution,
    expectedRows,
    signal,
  })
}

async function finishProjection(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  decision: ProjectionRunTerminalDecision
): Promise<void> {
  const common = {
    source: { projectionId: input.job.projectionId },
    datasetVersion: input.job.datasetVersion,
    execution: execution.execution,
  }
  await getOntologyMutationRuntime(input.runtime).finishProjection({
    ...common,
    ...decision,
  })
}

type ProjectionSuccessfulCompletion =
  | { readonly protocol: "replacement" }
  | { readonly protocol: "telemetry"; readonly inputExhausted: true }

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
    run.identity.projectionId === job.projectionId &&
    run.identity.projectionKind === job.projectionKind &&
    run.identity.protocol === job.protocol &&
    run.identity.datasetVersion.datasetId === job.datasetVersion.datasetId &&
    run.identity.datasetVersion.versionId === job.datasetVersion.versionId &&
    run.identity.datasetVersion.createdAt === job.datasetVersion.createdAt &&
    run.identity.ontologyRevision === job.ontologyRevision &&
    run.identity.projectionRevision === job.projectionRevision &&
    run.identity.ownershipHash === job.ownershipHash
  if (matches) return
  throw new ProjectionWorkerPermanentError(
    `[SixbProjectionWorker] Projection run '${run.id}' has a different durable identity.`
  )
}

function terminalResult(run: ProjectionRunRecord): ProjectionJobResult {
  return { run, replayedTerminal: true }
}

function isPermanentFailure(error: unknown, attempt: number): boolean {
  if (isMissingTargetWorthRetrying(error, attempt)) return false
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

export function isPermanentProjectionFailure(error: unknown, attempt = 1): boolean {
  return isPermanentFailure(error, attempt) || isExplicitCancellation(error)
}

/**
 * A telemetry target that does not exist *yet*.
 *
 * `MaterializationObjectNotFoundError` extends `MaterializationValidationError`, which is the
 * right reading for a caller appending telemetry by hand: an id that names no object is a bad
 * request. It is the wrong reading for a projection, whose dataset can legitimately be
 * materialized before the objects it references — the two are queued from separate dataset
 * versions and nothing sequences them. Failing the run on the first delivery turned a wait of
 * milliseconds into a permanent hole: nothing retries a failed run, and re-running the sync
 * produces no new version when the source has not changed.
 *
 * So it stays retryable while the budget lasts and becomes permanent after, which is what makes
 * a source id that names nothing distinguishable from one that is merely early.
 */
function isMissingTargetWorthRetrying(error: unknown, attempt: number): boolean {
  return (
    error instanceof MaterializationObjectNotFoundError && attempt < MISSING_TARGET_ATTEMPT_BUDGET
  )
}
