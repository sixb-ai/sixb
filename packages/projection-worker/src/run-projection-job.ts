import {
  isMaterializationConflictError,
  MaterializationCancellationError,
  MaterializationValidationError,
  type ProjectionDefinition,
  type SixbFailure,
} from "@sixb/core"
import { captureSixbFailure, isSixbError } from "@sixb/core/internal/errors"
import {
  MaterializationObjectNotFoundError,
  type ProjectionRunTerminalDecision,
} from "@sixb/core/internal/materialization"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import {
  PROJECTION_RUN_FAILURE_CODES,
  type ProjectionRunFailureCode,
  type ProjectionRunRecord,
} from "@sixb/core/storage"
import { ProjectionWorkerPermanentError } from "./errors"
import {
  assertProjectionJobId,
  type ValidatedProjectionJob,
  validateProjectionJob,
} from "./job-validation"
import { MISSING_TARGET_GRACE_MS } from "./retry-backoff"
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
      await finishProjection(input, execution, projectionFailure(input, error, "cancelled"))
      throw error
    }
    if ((await isPermanentFailure(input, execution, error)) && !signal.aborted) {
      await finishProjection(input, execution, projectionFailure(input, error, "failed"))
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
  decision: ProjectionRunTerminalDecision & { readonly finishedAt?: Date }
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

function projectionFailure(
  input: RunProjectionJobInput,
  error: unknown,
  status: "failed" | "cancelled"
): ProjectionRunTerminalDecision & {
  readonly status: "failed" | "cancelled"
  readonly finishedAt: Date
  readonly error: SixbFailure<ProjectionRunFailureCode>
} {
  const finishedAt = new Date(input.now?.() ?? Date.now())
  return {
    protocol: input.job.protocol,
    status,
    finishedAt,
    error: captureSixbFailure(error, {
      allowedCodes: PROJECTION_RUN_FAILURE_CODES,
      defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
      details: { projectionId: input.job.projectionId, runId: input.job.id },
      at: finishedAt,
    }),
  }
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

async function isPermanentFailure(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  error: unknown
): Promise<boolean> {
  if (error instanceof MaterializationObjectNotFoundError) {
    return missingTargetWaitedLongEnough(input, execution, error)
  }
  return isPermanentProjectionError(error)
}

function isPermanentProjectionError(error: unknown): boolean {
  if (isSixbError(error)) return !error.retryable
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

/**
 * The worker's read, on the one path where no run exists — `failureDecision` reads the run first
 * and retries whatever it left `running`. A target cannot be missing from a run that never
 * started, so there is no wait to measure.
 */
export function isPermanentProjectionFailure(error: unknown): boolean {
  return (
    (!(error instanceof MaterializationObjectNotFoundError) && isPermanentProjectionError(error)) ||
    isExplicitCancellation(error)
  )
}

/**
 * Whether a telemetry target has been missing long enough to give up on.
 *
 * `MaterializationObjectNotFoundError` extends `MaterializationValidationError`, which is the
 * right reading for a caller appending telemetry by hand and the wrong one for a projection: its
 * dataset can legitimately be materialized before the objects it references. Failing on the first
 * delivery turned a wait of milliseconds into a permanent hole — nothing retries a failed run, and
 * re-running the sync produces no new version when the source has not changed.
 *
 * The first delivery to find this object missing records the wait; later ones read it back and
 * compare. The batch it names is the run's own next ordinal, because the batch that failed is by
 * definition the one that did not commit.
 */
async function missingTargetWaitedLongEnough(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  error: MaterializationObjectNotFoundError
): Promise<boolean> {
  // Read and write both propagate. A storage failure here is not a wait that has run out: it
  // means the wait was never written down, and swallowing it would restart the window on every
  // delivery and leave the run running forever. Thrown, it reaches `failureDecision`, which
  // re-reads the run and redelivers.
  const run = await input.runtime.projectionRunsStorage.getById({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  const checkpoint = run?.telemetryCheckpoint
  if (!run || run.status !== "running" || !checkpoint) return false

  const waiting = run.missingTarget
  if (
    waiting &&
    waiting.objectTypeId === error.objectTypeId &&
    waiting.objectId === error.primaryId &&
    waiting.batchOrdinal === checkpoint.nextBatchOrdinal
  ) {
    const now = input.now?.() ?? Date.now()
    return now - waiting.firstSeenAt.getTime() >= MISSING_TARGET_GRACE_MS
  }

  await startMissingTargetWait(input, execution, error, checkpoint.nextBatchOrdinal)
  return false
}

async function startMissingTargetWait(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  error: MaterializationObjectNotFoundError,
  batchOrdinal: number
): Promise<void> {
  try {
    await input.runtime.projectionRunsStorage.recordMissingTarget({
      projectId: input.runtime.projectId,
      id: input.job.id,
      executionToken: execution.execution.executionToken,
      identity: input.job,
      missingTarget: {
        objectTypeId: error.objectTypeId,
        objectId: error.primaryId,
        batchOrdinal,
        firstSeenAt: new Date(input.now?.() ?? Date.now()),
      },
    })
  } catch (writeError) {
    // One expected loss: another delivery reclaimed this run between the failure and this
    // write, so it owns the wait now and will record its own. Everything else — an unreachable
    // database, a rejected invariant, a provider bug — is a real failure and stays one.
    if (!isLostExecution(writeError)) throw writeError
  }
}

function isLostExecution(error: unknown): boolean {
  return isMaterializationConflictError(error) && error.kind === "execution-lost"
}
