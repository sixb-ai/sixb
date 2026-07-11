import {
  assertJsonValue,
  type BlobStorage,
  cloneJsonValue,
  type DatasetVersion,
  type FileRef,
  getDatasetRowValidationError,
  isFileRef,
  type JsonValue,
  type LakeWriteSession,
  resolveLogsRuntime,
  type SyncRunFailure,
  type SyncRunRecord,
} from "@sixb/core"
import { assertDatasetRow, normalizeReadResult, throwIfAborted } from "./normalize"
import type { RunSyncJobInput, SyncRunResult } from "./types"

function toSyncRunFailure(error: unknown): SyncRunFailure {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    }
  }

  return {
    message: String(error),
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

/**
 * Run one sync job end to end using a caller-supplied run id.
 *
 * The worker creates the operational sync-run record, streams rows into lake
 * storage, commits one dataset version, and then finalizes the run record with
 * the outcome. It does not own scheduling, retries, or run-id generation.
 */
export async function runSyncJob(input: RunSyncJobInput): Promise<SyncRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal
  const { syncRunsStorage, lakeStorage, blobStorage } = runtime

  const sync = runtime.getSyncById(job.syncId)
  if (!sync) {
    throw new Error(`[SixbSyncWorker] Unknown sync '${job.syncId}'.`)
  }

  const dataset = runtime.getDatasetById(sync.target.dataset.id)
  if (!dataset) {
    throw new Error(
      `[SixbSyncWorker] Sync '${sync.id}' targets unknown dataset '${sync.target.dataset.id}'.`
    )
  }

  throwIfAborted(signal)

  const startedRun = await syncRunsStorage.start({
    projectId: runtime.id,
    id: job.id,
    syncId: sync.id,
    datasetId: dataset.id,
    mode: sync.config.mode,
    expectedLatestVersionId: job.expectedLatestVersionId,
    commitMessage: job.commitMessage,
  })
  await input.onRunStarted?.(startedRun)

  const logSession = resolveLogsRuntime(runtime.id, runtime.logs).startExecution({
    kind: "sync",
    id: job.id,
  })
  const logger = logSession.logger
  let write: LakeWriteSession | undefined
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

    const client = await runtime.connector(sync.connector)
    const readResult = await sync.read(client, {
      projectId: runtime.id,
      syncId: sync.id,
      signal,
      blobs: blobStorage,
      logger,
      checkpoint: previousCheckpoint !== undefined ? cloneJsonValue(previousCheckpoint) : undefined,
      setCheckpoint(next: unknown) {
        assertJsonValue(next, `Sync '${sync.id}' checkpoint`)
        nextCheckpoint = cloneJsonValue(next)
      },
    })
    const rows = normalizeReadResult(readResult, sync.id)

    throwIfAborted(signal)

    write = await lakeStorage.beginWrite({
      dataset,
      mode: sync.config.mode,
      producer: {
        kind: "sync",
        id: sync.id,
        runId: job.id,
      },
    })

    await write.writeRows(
      (async function* () {
        let itemIndex = 0

        for await (const value of rows) {
          throwIfAborted(signal)
          itemIndex += 1

          const row = assertDatasetRow(value, sync.id, itemIndex)
          // Validate before handing rows to lake storage so sync failures include
          // the source item index; lake storage still re-validates as the final boundary.
          const validationError = getDatasetRowValidationError(row, dataset)
          if (validationError) {
            throw new Error(
              `[SixbSyncWorker] Sync '${sync.id}' returned an invalid row at item ${itemIndex}. ${validationError}`
            )
          }

          // Lake storage validates fileRef shape; the worker owns existence checks against blob storage.
          await verifyRowFileRefs({
            blobStorage,
            syncId: sync.id,
            dataset,
            row,
            itemIndex,
          })

          rowsRead += 1
          yield row
        }
      })()
    )

    throwIfAborted(signal)

    const version = await write.commit({
      expectedLatestVersionId: job.expectedLatestVersionId,
      commitMessage: job.commitMessage ?? `sync ${sync.id} run ${job.id}`,
    })
    committedVersion = version
    let finishedRun: SyncRunRecord

    try {
      finishedRun = await syncRunsStorage.finish({
        projectId: runtime.id,
        id: job.id,
        status: "succeeded",
        rowsRead,
        output: {
          datasetId: version.datasetId,
          versionId: version.versionId,
        },
        checkpoint: nextCheckpoint,
      })
    } catch (error) {
      throw createBookkeepingError({
        syncId: sync.id,
        runId: job.id,
        version,
        cause: error,
      })
    }

    return {
      id: job.id,
      syncId: sync.id,
      datasetId: dataset.id,
      mode: sync.config.mode,
      startedAt: startedRun.startedAt,
      finishedAt: requireFinishedAt(job.id, finishedRun.finishedAt),
      rowsRead,
      version,
    }
  } catch (error) {
    if (!committedVersion) {
      // Before commit succeeds we can still best-effort clean up both the write session and run record.
      await write?.abort().catch(() => {})

      await syncRunsStorage
        .finish({
          projectId: runtime.id,
          id: job.id,
          status: signal.aborted ? "cancelled" : "failed",
          rowsRead,
          error: toSyncRunFailure(error),
        })
        .catch(() => {})
    }

    throw error
  } finally {
    await logSession.flush()
  }
}
