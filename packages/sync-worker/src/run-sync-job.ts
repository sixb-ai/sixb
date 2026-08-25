import {
  type BlobStorage,
  cloneJsonValue,
  type DatasetDefinition,
  type DatasetRow,
  type FileRef,
  getDatasetRowValidationError,
  isFileRef,
  type JsonValue,
  type MergeChange,
} from "@sixb/core"
import {
  captureSixbFailure,
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
} from "@sixb/core/internal/errors"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import { type DatasetVersion, getDatasetMergeChangeValidationError } from "@sixb/core/lake-storage"
import { SYNC_RUN_FAILURE_CODES, type SyncRunRecord } from "@sixb/core/storage"
import { assertDatasetRow, throwIfAborted } from "./normalize"
import { readSyncValues } from "./source-read"
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

async function verifyFileRef(options: {
  blobStorage: BlobStorage
  syncId: string
  datasetId: string
  columnName: string
  itemIndex: number
  fileRef: FileRef
}): Promise<void> {
  const blobInfo = await options.blobStorage.stat(options.fileRef.blobId)
  if (!blobInfo) {
    throw new Error(
      `[SixbSyncWorker] Sync '${options.syncId}' returned row ${options.itemIndex} with dataset '${options.datasetId}' column '${options.columnName}' referencing unknown blob '${options.fileRef.blobId}'.`
    )
  }

  if (blobInfo.digest !== options.fileRef.digest) {
    throw new Error(
      `[SixbSyncWorker] Sync '${options.syncId}' returned row ${options.itemIndex} with dataset '${options.datasetId}' column '${options.columnName}' referencing blob '${options.fileRef.blobId}' with digest '${options.fileRef.digest}', but blob storage has '${blobInfo.digest}'.`
    )
  }

  if (blobInfo.sizeBytes !== options.fileRef.sizeBytes) {
    throw new Error(
      `[SixbSyncWorker] Sync '${options.syncId}' returned row ${options.itemIndex} with dataset '${options.datasetId}' column '${options.columnName}' referencing blob '${options.fileRef.blobId}' with size ${options.fileRef.sizeBytes}, but blob storage has ${blobInfo.sizeBytes}.`
    )
  }
}

async function verifyRowFileRefs(options: {
  blobStorage: BlobStorage
  syncId: string
  dataset: { id: string; schema: { columns: readonly { name: string; type: string }[] } }
  row: Record<string, unknown>
  itemIndex: number
}): Promise<void> {
  const fileRefColumns = options.dataset.schema.columns.filter(
    (column) => column.type === "fileRef"
  )
  for (const column of fileRefColumns) {
    const value = options.row[column.name]
    if (!isFileRef(value)) {
      continue
    }

    await verifyFileRef({
      blobStorage: options.blobStorage,
      syncId: options.syncId,
      datasetId: options.dataset.id,
      columnName: column.name,
      itemIndex: options.itemIndex,
      fileRef: value,
    })
  }
}

function assertMergeChange(
  value: unknown,
  syncId: string,
  dataset: DatasetDefinition,
  itemIndex: number
): MergeChange<DatasetRow, DatasetRow> {
  const validationError = getDatasetMergeChangeValidationError(value, dataset)
  if (validationError) {
    throw new Error(
      `[SixbSyncWorker] Sync '${syncId}' returned an invalid merge change at item ${itemIndex}. ${validationError}`
    )
  }
  return value as MergeChange<DatasetRow, DatasetRow>
}

async function* validatedDatasetRows(options: {
  values: AsyncIterable<unknown>
  signal: AbortSignal
  blobStorage: BlobStorage
  syncId: string
  dataset: DatasetDefinition
  onRead(): void
}): AsyncIterable<DatasetRow> {
  let itemIndex = 0
  for await (const value of options.values) {
    throwIfAborted(options.signal)
    itemIndex += 1

    const row = assertDatasetRow(value, options.syncId, itemIndex)
    // Validate before handing rows to lake storage so sync failures include
    // the source item index; lake storage still re-validates as the final boundary.
    const validationError = getDatasetRowValidationError(row, options.dataset)
    if (validationError) {
      throw new Error(
        `[SixbSyncWorker] Sync '${options.syncId}' returned an invalid row at item ${itemIndex}. ${validationError}`
      )
    }

    // Lake storage validates fileRef shape; the worker owns existence checks against blob storage.
    await verifyRowFileRefs({
      blobStorage: options.blobStorage,
      syncId: options.syncId,
      dataset: options.dataset,
      row,
      itemIndex,
    })

    options.onRead()
    yield row
  }
}

async function* validatedMergeChanges(options: {
  values: AsyncIterable<unknown>
  signal: AbortSignal
  blobStorage: BlobStorage
  syncId: string
  dataset: DatasetDefinition
  onRead(): void
}): AsyncIterable<MergeChange<DatasetRow, DatasetRow>> {
  let itemIndex = 0
  for await (const value of options.values) {
    throwIfAborted(options.signal)
    itemIndex += 1
    const mergeChange = assertMergeChange(value, options.syncId, options.dataset, itemIndex)
    if (mergeChange.kind === "upsert") {
      await verifyRowFileRefs({
        blobStorage: options.blobStorage,
        syncId: options.syncId,
        dataset: options.dataset,
        row: mergeChange.row,
        itemIndex,
      })
    }
    options.onRead()
    yield mergeChange
  }
}

interface SyncCommitResult {
  readonly outcome: "created" | "unchanged"
  readonly version?: DatasetVersion
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
  let abortWrite: (() => Promise<void>) | undefined
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

    throwIfAborted(signal)
    await lakeStorage.createDataset(dataset)

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
    const onRead = () => {
      rowsRead += 1
    }
    const commitMessage = job.commitMessage ?? `sync ${sync.id} run ${job.id}`
    let commitResult: SyncCommitResult

    if (sync.config.mode === "merge") {
      const mergeWrite = await lakeStorage.beginMerge({
        dataset,
        expectedLatestVersionId: job.expectedLatestVersionId,
        producer,
      })
      abortWrite = () => mergeWrite.abort()

      const values = await readValues()
      throwIfAborted(signal)
      await mergeWrite.writeChanges(
        validatedMergeChanges({
          values,
          signal,
          blobStorage,
          syncId: sync.id,
          dataset,
          onRead,
        })
      )
      throwIfAborted(signal)

      const commit = await mergeWrite.commit({ commitMessage })
      abortWrite = undefined
      commitResult = {
        outcome: commit.outcome,
        ...(commit.version ? { version: commit.version } : {}),
      }
    } else {
      const values = await readValues()
      throwIfAborted(signal)

      const rowWrite = await lakeStorage.beginWrite({
        dataset,
        mode: sync.config.mode,
        producer,
      })
      abortWrite = () => rowWrite.abort()
      await rowWrite.writeRows(
        validatedDatasetRows({
          values,
          signal,
          blobStorage,
          syncId: sync.id,
          dataset,
          onRead,
        })
      )
      throwIfAborted(signal)

      if (rowsRead === 0) {
        const version = await lakeStorage.getLatestVersion(dataset.id)
        if (sync.config.mode === "append" || !version) {
          await rowWrite.abort()
          abortWrite = undefined
          const finishedRun = await syncRunsStorage.finish({
            projectId: runtime.id,
            id: job.id,
            status: "succeeded",
            rowsRead,
            ...(version
              ? { output: { datasetId: version.datasetId, versionId: version.versionId } }
              : {}),
            checkpoint: nextCheckpoint,
          })
          const finishedAt = requireFinishedAt({
            syncId: sync.id,
            runId: job.id,
            finishedAt: finishedRun.finishedAt,
          })
          await notifyRunFinished(input.onRunFinished, finishedRun)

          return {
            id: job.id,
            syncId: sync.id,
            datasetId: dataset.id,
            mode: sync.config.mode,
            startedAt: requireStartedAt(job.id, startedRun.startedAt),
            finishedAt,
            rowsRead,
            ...(version ? { version } : {}),
            versionCreated: false,
          }
        }
      }

      const { outcome, ...version } = await rowWrite.commit({
        expectedLatestVersionId: job.expectedLatestVersionId,
        commitMessage,
      })
      abortWrite = undefined
      commitResult = { outcome, version }
    }

    const { outcome, version } = commitResult
    if (outcome === "created") {
      if (!version) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbSyncWorker] Sync '${sync.id}' created no dataset version.`,
          { details: { syncId: sync.id, runId: job.id, datasetId: dataset.id } }
        )
      }
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
      // Without a created commit, best-effort clean up any open session and the run record.
      await abortWrite?.().catch(() => {})

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
