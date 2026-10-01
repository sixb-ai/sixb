import type { SixbFailure } from "@sixb/core"
import {
  isMaterializationConflictError,
  MaterializationCancellationError,
  MaterializationValidationError,
  type ProjectionDefinition,
} from "@sixb/core"
import {
  captureSixbFailure,
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
} from "@sixb/core/internal/errors"
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
import { collectIdentityMismatches } from "./identity-mismatch"
import { prepareIncrementalReplacement } from "./incremental-replacement"
import {
  assertProjectionJobId,
  type ValidatedProjectionJob,
  validateProjectionJob,
} from "./job-validation"
import { MISSING_TARGET_GRACE_MS } from "./retry-backoff"
import { mapLinkProjectionEntries } from "./run-link-projection"
import { mapObjectProjectionEntries } from "./run-object-projection"
import { runTelemetryProjection } from "./run-telemetry-projection"
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

  const execution = await claimOrReplaySettledRun(input)
  if ("replayedTerminal" in execution) return execution
  // Outside the try below: a supersession that fails is retried by the next delivery, never
  // turned into a failed run.
  if (await supersedeStaleRun(input, execution)) {
    return { run: await requireRun(input), replayedTerminal: false }
  }
  try {
    const validated = await validateProjectionJob(input.runtime, input.job)
    const completion = await materializeProjection(input, validated, execution, signal)
    await finishProjection(input, execution, { ...completion, status: "succeeded" })
    return { run: await requireRun(input), replayedTerminal: false }
  } catch (error) {
    const settled = await findSettledRun(input)
    if (settled) return terminalResult(settled)

    if (isExplicitCancellation(error)) {
      await finishProjection(input, execution, projectionFailure(input, error, "cancelled"))
      throw error
    }
    const permanent = await isPermanentFailure(input, execution, error)
    if (permanent && !signal.aborted) {
      const decision = projectionFailure(input, error, "failed")
      await finishProjection(input, execution, decision)
      const run = await requireRun(input)
      input.onRunFailed?.(error, run, decision.error)
    } else if (!signal.aborted) {
      await recordAttemptFailure(input, execution, error)
    }
    // Transient errors, delivery loss, shutdown, and stale executions deliberately leave the run
    // running so the next QueueDelivery can reclaim it with a fresh token.
    throw error
  }
}

async function claimOrReplaySettledRun(
  input: RunProjectionJobInput
): Promise<ClaimedProjectionExecution | ProjectionJobResult> {
  try {
    return await claimExecution(input)
  } catch (error) {
    // Another delivery may have settled the run after our initial terminal read but before the
    // claim.
    const settled = await findSettledRun(input)
    if (settled) return terminalResult(settled)
    throw error
  }
}

/**
 * Ends a replacement run without materializing it when a run of a later dataset version stands
 * to replace the source anyway: its output would be stale on arrival, and on a large projection
 * producing it can take hours. Checked on every delivery, so a run that is retrying also stops
 * once a newer version arrives. The materializer checks again under the finish transaction.
 */
async function supersedeStaleRun(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution
): Promise<boolean> {
  if (input.job.protocol !== "replacement") return false
  const newer = await input.runtime.projectionRunsStorage.findSupersedingRun({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  if (!newer) return false
  await finishProjection(input, execution, {
    protocol: "replacement",
    status: "superseded",
    finishedAt: new Date(input.now?.() ?? Date.now()),
  })
  return true
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
  if (run.status === "queued" || run.status === "running") return null
  if (isSettled(run)) return run
  throw createSixbError(
    "projection.run_already_terminal",
    `[SixbProjectionWorker] Projection run '${run.id}' is already '${run.status}'.`,
    {
      details: {
        projectionId: run.identity.projectionId,
        runId: run.id,
        datasetId: run.identity.datasetVersion.datasetId,
        versionId: run.identity.datasetVersion.versionId,
        status: run.status,
      },
    }
  )
}

async function claimExecution(input: RunProjectionJobInput): Promise<ClaimedProjectionExecution> {
  const run = await requireRun(input)
  assertRunMatchesJob(run, input.job)
  const common = { projectId: run.projectId, id: run.id }
  switch (run.identity.projectionKind) {
    case "object": {
      if (!("objectTypeId" in run.target)) throw inconsistentRunTarget(run)
      return input.runtime.projectionRunsStorage.startOrReclaim({
        ...common,
        identity: run.identity,
        target: run.target,
      })
    }
    case "link": {
      if (!("sourceObjectTypeId" in run.target)) throw inconsistentRunTarget(run)
      return input.runtime.projectionRunsStorage.startOrReclaim({
        ...common,
        identity: run.identity,
        target: run.target,
      })
    }
    case "telemetry": {
      if (!("objectTypeId" in run.target) || !run.telemetryCheckpoint) {
        throw inconsistentRunTarget(run)
      }
      return input.runtime.projectionRunsStorage.startOrReclaim({
        ...common,
        identity: run.identity,
        target: run.target,
        fixedBatchSize: input.telemetryBatchSize ?? run.telemetryCheckpoint.fixedBatchSize,
      })
    }
  }
}

function inconsistentRunTarget(run: ProjectionRunRecord): ReturnType<typeof createSixbError> {
  return createSixbError(
    "internal.unexpected",
    `[SixbProjectionWorker] Projection run '${run.id}' has inconsistent target metadata.`,
    {
      details: {
        projectionId: run.identity.projectionId,
        projectionKind: run.identity.projectionKind,
        runId: run.id,
      },
    }
  )
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
      const incremental = await prepareIncrementalReplacement({
        runtime: input.runtime,
        projection: validated.projection,
        dataset: validated.dataset,
        execution,
        expectedRows: validated.version.rowCount,
        signal,
      })
      try {
        const entries =
          incremental?.entries ??
          replacementEntries(
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
          ...(incremental ? { base: incremental.base } : {}),
          signal,
        })
      } finally {
        await incremental?.close()
      }
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

/**
 * Every terminal transition goes through the materializer, including a failure found before
 * materialization began: an earlier delivery of the same run may have left a candidate, and only
 * the materializer's finish releases it in the same transaction.
 */
async function finishProjection(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  decision: ProjectionRunTerminalDecision & { readonly finishedAt?: Date }
): Promise<void> {
  await getOntologyMutationRuntime(input.runtime).finishProjection({
    source: { projectionId: input.job.projectionId },
    datasetVersion: input.job.datasetVersion,
    execution: execution.execution,
    ...decision,
  })
}

/**
 * Keeps the failure of an attempt the queue will retry on the run, so a projection that keeps
 * failing says why while it is still running. Best effort: the error that caused the retry is
 * what propagates, and the next attempt records its own failure.
 */
async function recordAttemptFailure(
  input: RunProjectionJobInput,
  execution: ClaimedProjectionExecution,
  error: unknown
): Promise<void> {
  try {
    await input.runtime.projectionRunsStorage.recordAttemptFailure({
      projectId: input.runtime.projectId,
      id: input.job.id,
      executionToken: execution.execution.executionToken,
      identity: input.job,
      error: projectionFailure(input, error, "failed").error,
    })
  } catch (writeError) {
    // Another delivery reclaimed the run: the failure it records is the latest one now.
    if (isLostExecution(writeError)) return
    console.warn(
      `[SixbProjectionWorker] Projection run '${input.job.id}' could not record the failure of its attempt; it will be retried.`,
      writeError
    )
  }
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
  const failureError = status === "failed" ? translateProjectionExecutionError(input, error) : error
  return {
    protocol: input.job.protocol,
    status,
    finishedAt,
    error: captureSixbFailure(failureError, {
      allowedCodes: PROJECTION_RUN_FAILURE_CODES,
      defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
      details: { projectionId: input.job.projectionId, runId: input.job.id },
      at: finishedAt,
    }),
  }
}

function translateProjectionExecutionError(input: RunProjectionJobInput, error: unknown): unknown {
  if (
    isSixbError(error) &&
    (error.code === "internal.unexpected" ||
      error.code === "projection.execution_failed" ||
      error.code === "storage.unavailable")
  ) {
    return error
  }

  return createSixbError(
    "projection.execution_failed",
    summarizeErrorMessage(error, "Projection execution failed."),
    {
      cause: error,
      details: {
        projectionId: input.job.projectionId,
        runId: input.job.id,
        datasetId: input.job.datasetVersion.datasetId,
        versionId: input.job.datasetVersion.versionId,
      },
    }
  )
}

type ProjectionSuccessfulCompletion =
  | { readonly protocol: "replacement" }
  | { readonly protocol: "telemetry"; readonly inputExhausted: true }

/** A run that ended without a failure: a redelivery has nothing left to do or report. */
function isSettled(run: ProjectionRunRecord): boolean {
  return run.status === "succeeded" || run.status === "superseded"
}

async function findSettledRun(input: RunProjectionJobInput): Promise<ProjectionRunRecord | null> {
  try {
    const run = await input.runtime.projectionRunsStorage.getById({
      projectId: input.runtime.projectId,
      id: input.job.id,
    })
    return run && isSettled(run) ? run : null
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
  const identityMismatches = collectIdentityMismatches([
    {
      field: "projectionId",
      expected: job.projectionId,
      actual: run.identity.projectionId,
    },
    {
      field: "projectionKind",
      expected: job.projectionKind,
      actual: run.identity.projectionKind,
    },
    { field: "protocol", expected: job.protocol, actual: run.identity.protocol },
    {
      field: "datasetId",
      expected: job.datasetVersion.datasetId,
      actual: run.identity.datasetVersion.datasetId,
    },
    {
      field: "versionId",
      expected: job.datasetVersion.versionId,
      actual: run.identity.datasetVersion.versionId,
    },
    {
      field: "versionCreatedAt",
      expected: job.datasetVersion.createdAt,
      actual: run.identity.datasetVersion.createdAt,
    },
    {
      field: "ontologyRevision",
      expected: job.ontologyRevision,
      actual: run.identity.ontologyRevision,
    },
    {
      field: "projectionRevision",
      expected: job.projectionRevision,
      actual: run.identity.projectionRevision,
    },
    {
      field: "ownershipHash",
      expected: job.ownershipHash,
      actual: run.identity.ownershipHash,
    },
  ])
  if (identityMismatches.length === 0) return
  throw createSixbError(
    "projection.run_identity_mismatch",
    `[SixbProjectionWorker] Projection run '${run.id}' has a different durable identity.`,
    {
      details: {
        projectionId: job.projectionId,
        runId: run.id,
        identityMismatches,
      },
    }
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
  if (error instanceof MaterializationValidationError) {
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
