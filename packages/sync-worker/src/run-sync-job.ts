import { cloneJsonValue, type DatasetDefinition, type JsonValue } from "@sixb/core"
import { writeDataset } from "@sixb/core/internal/datasets"
import {
  captureSixbFailure,
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
} from "@sixb/core/internal/errors"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { SYNC_RUN_FAILURE_CODES, type SyncRunRecord } from "@sixb/core/storage"
import { throwIfAborted } from "./normalize"
import { readSyncValues, type SyncSourceValue } from "./source-read"
import type { RunSyncJobInput, SyncRunFinishedHandler, SyncRunResult } from "./types"

export class SyncRunAlreadyStartedError extends Error {
  override readonly name = "SyncRunAlreadyStartedError"

  constructor(readonly run: SyncRunRecord) {
    super(`[SixbSyncWorker] Sync run '${run.id}' has already started.`)
  }
}

function createBookkeepingError(options: {
  syncId: string
  runId: string
  version: DatasetVersion
  cause: unknown
}): Error {
  // The lake commit is already durable here, so we surface an explicit repair-needed error.
  return createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync '${options.syncId}' committed dataset version '${options.version.versionId}', but failed to finalize sync run '${options.runId}'. The dataset commit may already have succeeded and the sync run record may need repair.`,
    {
      cause: options.cause,
      details: {
        syncId: options.syncId,
        runId: options.runId,
        datasetId: options.version.datasetId,
        versionId: options.version.versionId,
      },
    }
  )
}

function requireFinishedAt(input: {
  readonly syncId: string
  readonly runId: string
  readonly finishedAt: Date | undefined
}): Date {
  if (input.finishedAt) {
    return input.finishedAt
  }

  throw createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync run '${input.runId}' finished without a finishedAt timestamp.`,
    { details: { syncId: input.syncId, runId: input.runId } }
  )
}

function translateSyncExecutionError(
  error: unknown,
  input: {
    readonly syncId: string
    readonly runId: string
    readonly datasetId: string
  }
): unknown {
  if (
    isSixbError(error) &&
    (error.code === "internal.unexpected" || error.code === "sync.execution_failed")
  ) {
    return error
  }

  return createSixbError(
    "sync.execution_failed",
    summarizeErrorMessage(error, "Sync execution failed."),
    {
      cause: error,
      details: {
        syncId: input.syncId,
        runId: input.runId,
        datasetId: input.datasetId,
      },
    }
  )
}

function sourceValidationError(
  error: unknown,
  sourceValue: SyncSourceValue,
  options: { readonly syncId: string; readonly runId: string; readonly dataset: DatasetDefinition },
  itemIndex: number
): unknown {
  const connection = sourceValue.connection
  if (!connection) return error
  const code =
    isSixbError(error) && error.code === "internal.unexpected"
      ? "internal.unexpected"
      : "sync.execution_failed"
  return createSixbError(code, summarizeErrorMessage(error, "Sync source validation failed."), {
    cause: error,
    details: {
      syncId: options.syncId,
      runId: options.runId,
      datasetId: options.dataset.id,
      itemIndex,
      connectionId: connection.id,
      accountId: connection.account.id,
    },
  })
}

/**
 * Run one already-persisted Sync run end to end.
 *
 * Dispatch owns identity and queueing. The worker only transitions the durable run from queued to
 * running, streams source values, and records its terminal outcome.
 */
export async function runSyncJob(input: RunSyncJobInput): Promise<SyncRunResult> {
  const { runtime, run } = input
  const job = {
    id: run.id,
    syncId: run.syncId,
    expectedLatestVersionId: run.expectedLatestVersionId,
    commitMessage: run.commitMessage,
  }
  const signal = input.signal ?? new AbortController().signal
  const { syncRunsStorage, lakeStorage, blobs: blobStorage } = runtime

  if (run.projectId !== runtime.id) {
    throw new Error(
      `[SixbSyncWorker] Sync run '${run.id}' belongs to project '${run.projectId}', not '${runtime.id}'.`
    )
  }

  throwIfAborted(signal)

  let startedRun: SyncRunRecord
  try {
    startedRun = await syncRunsStorage.start({
      projectId: runtime.id,
      id: job.id,
    })
  } catch (error) {
    const existing = await syncRunsStorage.getById({ projectId: runtime.id, id: job.id })
    if (existing?.syncId === run.syncId && existing.executionId === run.executionId) {
      throw new SyncRunAlreadyStartedError(existing)
    }
    throw error
  }
  await input.onRunStarted?.(startedRun)

  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "sync",
    id: job.id,
  })
  const logger = logSession.logger
  let rowsRead = 0
  let committedVersion: DatasetVersion | undefined

  try {
    const sync = runtime.syncs.getById(run.syncId)
    if (!sync) {
      throw new Error(`[SixbSyncWorker] Unknown sync '${run.syncId}'.`)
    }
    if (sync.target.dataset.id !== run.datasetId || sync.config.mode !== run.mode) {
      throw new Error(
        `[SixbSyncWorker] Sync run '${run.id}' no longer matches Sync '${sync.id}' configuration.`
      )
    }

    const dataset = runtime.datasets.getById(run.datasetId)
    if (!dataset) {
      throw new Error(
        `[SixbSyncWorker] Sync '${sync.id}' targets unknown dataset '${run.datasetId}'.`
      )
    }

    const latestSuccessfulRuns = await syncRunsStorage.list({
      projectId: runtime.id,
      syncId: sync.id,
      statuses: ["succeeded"],
      limit: 1,
      order: "desc",
    })
    const previousCheckpoint = latestSuccessfulRuns.runs[0]?.checkpoint
    let nextCheckpoint: JsonValue | undefined =
      previousCheckpoint !== undefined ? cloneJsonValue(previousCheckpoint) : undefined

    const producer = {
      kind: "sync" as const,
      id: sync.id,
      runId: job.id,
    }
    const readValues = () =>
      readSyncValues({
        runtime,
        sync,
        runId: job.id,
        datasetId: dataset.id,
        signal,
        blobStorage,
        logger,
        previousCheckpoint,
        setCheckpoint(next) {
          nextCheckpoint = next === undefined ? undefined : cloneJsonValue(next)
        },
      })
    const { outcome, version } = await writeDataset({
      lakeStorage,
      blobStorage,
      dataset,
      mode: sync.config.mode,
      signal,
      producer,
      readValues,
      expectedLatestVersionId: job.expectedLatestVersionId,
      commitMessage: job.commitMessage ?? `sync ${sync.id} run ${job.id}`,
      sourceLabel: `[SixbSyncWorker] Sync '${sync.id}'`,
      onRead(count) {
        rowsRead = count
      },
      mapValidationError: (error, value, itemIndex) =>
        sourceValidationError(error, value, { syncId: sync.id, runId: job.id, dataset }, itemIndex),
    })
    if (outcome === "created") {
      committedVersion = version
    }
    let finishedRun: SyncRunRecord

    try {
      finishedRun = await syncRunsStorage.finish({
        projectId: runtime.id,
        id: job.id,
        status: "succeeded",
        rowsRead,
        ...(version
          ? { output: { datasetId: version.datasetId, versionId: version.versionId } }
          : {}),
        checkpoint: nextCheckpoint,
      })
    } catch (error) {
      if (committedVersion) {
        throw createBookkeepingError({
          syncId: sync.id,
          runId: job.id,
          version: committedVersion,
          cause: error,
        })
      }
      throw error
    }

    const finishedAt = requireFinishedAt({
      syncId: sync.id,
      runId: job.id,
      finishedAt: finishedRun.finishedAt,
    })
    await notifyRunFinished(input.onRunFinished, finishedRun, committedVersion)
    const result = {
      id: job.id,
      syncId: sync.id,
      datasetId: dataset.id,
      mode: sync.config.mode,
      startedAt: requireStartedAt(job.id, startedRun.startedAt),
      finishedAt,
      rowsRead,
    }
    return version
      ? { ...result, version, versionCreated: outcome === "created" }
      : { ...result, versionCreated: false }
  } catch (error) {
    if (!committedVersion) {
      // The shared writer has already cleaned up its session. Finalize the failed sync run.
      const status = signal.aborted ? "cancelled" : "failed"
      try {
        const failureError =
          status === "failed"
            ? translateSyncExecutionError(error, {
                syncId: run.syncId,
                runId: job.id,
                datasetId: run.datasetId,
              })
            : error
        const failure = captureSixbFailure(failureError, {
          allowedCodes: SYNC_RUN_FAILURE_CODES,
          defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
          details: { syncId: run.syncId, runId: job.id, datasetId: run.datasetId },
        })
        const failedRun = await syncRunsStorage.finish({
          projectId: runtime.id,
          id: job.id,
          status,
          rowsRead,
          error: failure,
        })
        await notifyRunFinished(input.onRunFinished, failedRun)
        if (status === "failed" && failedRun.status === "failed") {
          input.onRunFailed?.(error, failedRun, failure)
        }
      } catch {
        // The run did not transition to the requested terminal status.
      }
    }

    throw error
  } finally {
    await logSession.flush()
  }
}

async function notifyRunFinished(
  handler: SyncRunFinishedHandler | undefined,
  run: SyncRunRecord,
  createdVersion?: DatasetVersion
): Promise<void> {
  try {
    await handler?.(run, createdVersion)
  } catch (error) {
    // The built-in event log reports lost batches itself. Anything reaching here is a broken
    // invariant in a custom lifecycle handler and must not change an already durable outcome.
    console.error("[SixbSyncWorker] Sync run lifecycle handler failed:", error)
  }
}

function requireStartedAt(runId: string, startedAt: Date | undefined): Date {
  if (startedAt) return startedAt
  throw createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync run '${runId}' started without a startedAt timestamp.`,
    { details: { runId } }
  )
}
