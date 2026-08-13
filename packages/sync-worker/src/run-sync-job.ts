import {
  assertJsonValue,
  type BlobStorage,
  cloneJsonValue,
  type DatasetDefinition,
  type DatasetRow,
  type FileRef,
  getDatasetRowValidationError,
  isFileRef,
  type JsonValue,
  type Logger,
  type MergeChange,
  type SyncDefinition,
} from "@sixb/core"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import { type DatasetVersion, getDatasetMergeChangeValidationError } from "@sixb/core/lake-storage"
import { SYNC_RUN_FAILURE_CODES, type SyncRunRecord } from "@sixb/core/storage"
import { assertDatasetRow, normalizeReadResult, throwIfAborted } from "./normalize"
import type {
  RunSyncJobInput,
  SyncRunFinishedHandler,
  SyncRunResult,
  SyncWorkerContext,
} from "./types"

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
  return new Error(
    `[SixbSyncWorker] Sync '${options.syncId}' committed dataset version '${options.version.versionId}', but failed to finalize sync run '${options.runId}'. The dataset commit may already have succeeded and the sync run record may need repair.`,
    { cause: options.cause }
  )
}

function requireFinishedAt(runId: string, finishedAt: Date | undefined): Date {
  if (finishedAt) {
    return finishedAt
  }

  throw new Error(`[SixbSyncWorker] Sync run '${runId}' finished without a finishedAt timestamp.`)
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

async function readSyncValues(options: {
  runtime: SyncWorkerContext
  sync: SyncDefinition
  signal: AbortSignal
  blobStorage: BlobStorage
  logger: Logger
  previousCheckpoint: JsonValue | undefined
  setCheckpoint(next: unknown): void
}): Promise<AsyncIterable<unknown>> {
  const client = await options.runtime.connector(options.sync.connector)
  const readResult = await options.sync.read(client, {
    projectId: options.runtime.id,
    syncId: options.sync.id,
    signal: options.signal,
    blobs: options.blobStorage,
    logger: options.logger,
    checkpoint:
      options.previousCheckpoint !== undefined
        ? cloneJsonValue(options.previousCheckpoint)
        : undefined,
    setCheckpoint: options.setCheckpoint,
  })
  return normalizeReadResult(readResult, options.sync.id)
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
 * Run one sync job end to end using a caller-supplied run id.
 *
 * The worker creates the operational sync-run record, streams source values into lake storage,
 * commits or reuses a dataset version when one exists, and then finalizes the run record. It does
 * not own scheduling, retries, or run-id generation.
 */
export async function runSyncJob(input: RunSyncJobInput): Promise<SyncRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal
  const { syncRunsStorage, lakeStorage, blobs: blobStorage } = runtime

  const sync = runtime.syncs.getById(job.syncId)
  if (!sync) {
    throw new Error(`[SixbSyncWorker] Unknown sync '${job.syncId}'.`)
  }

  const dataset = runtime.datasets.getById(sync.target.dataset.id)
  if (!dataset) {
    throw new Error(
      `[SixbSyncWorker] Sync '${sync.id}' targets unknown dataset '${sync.target.dataset.id}'.`
    )
  }

  throwIfAborted(signal)

  let startedRun: SyncRunRecord
  try {
    startedRun = await syncRunsStorage.start({
      projectId: runtime.id,
      id: job.id,
      syncId: sync.id,
      datasetId: dataset.id,
      mode: sync.config.mode,
      expectedLatestVersionId: job.expectedLatestVersionId,
      commitMessage: job.commitMessage,
    })
  } catch (error) {
    const existing = await syncRunsStorage.getById({ projectId: runtime.id, id: job.id })
    if (existing?.syncId === sync.id && existing.datasetId === dataset.id) {
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
        signal,
        blobStorage,
        logger,
        previousCheckpoint,
        setCheckpoint(next) {
          assertJsonValue(next, `Sync '${sync.id}' checkpoint`)
          nextCheckpoint = cloneJsonValue(next)
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
          const finishedAt = requireFinishedAt(job.id, finishedRun.finishedAt)
          await notifyRunFinished(input.onRunFinished, finishedRun)

          return {
            id: job.id,
            syncId: sync.id,
            datasetId: dataset.id,
            mode: sync.config.mode,
            startedAt: startedRun.startedAt,
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
        throw new Error(`[SixbSyncWorker] Sync '${sync.id}' created no dataset version.`)
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

    const finishedAt = requireFinishedAt(job.id, finishedRun.finishedAt)
    await notifyRunFinished(input.onRunFinished, finishedRun, committedVersion)
    const result = {
      id: job.id,
      syncId: sync.id,
      datasetId: dataset.id,
      mode: sync.config.mode,
      startedAt: startedRun.startedAt,
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
        const failure = captureSixbFailure(error, {
          allowedCodes: SYNC_RUN_FAILURE_CODES,
          defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
          details: { syncId: sync.id, runId: job.id },
        })
        const run = await syncRunsStorage.finish({
          projectId: runtime.id,
          id: job.id,
          status,
          rowsRead,
          error: failure,
        })
        await notifyRunFinished(input.onRunFinished, run)
        if (status === "failed" && run.status === "failed") {
          input.onRunFailed?.(error, run, failure)
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
