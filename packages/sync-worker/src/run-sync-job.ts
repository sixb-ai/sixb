import {
  cloneJsonValue,
  type DatasetDefinition,
  type JsonValue,
  type SyncDefinition,
} from "@sixb/core"
import { findProducedVersion, writeDataset } from "@sixb/core/internal/datasets"
import {
  captureSixbFailure,
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
} from "@sixb/core/internal/errors"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import { type DatasetVersion, LakeConcurrencyError } from "@sixb/core/lake-storage"
import { SYNC_RUN_FAILURE_CODES, type SyncRunRecord } from "@sixb/core/storage"
import { throwIfAborted } from "./normalize"
import { readSyncValues, type SyncSourceValue } from "./source-read"
import type { RunSyncJobInput, SyncRunFinishedHandler, SyncRunResult } from "./types"

/** What the execution behind a commit read, which the run records once it finds that commit. */
interface LandedRead {
  readonly rowsRead: number
  readonly checkpoint: JsonValue | undefined
}

/** What a run found just before committing: an earlier execution's commit landed after all. */
class CommitAlreadyLandedError extends Error {
  override readonly name = "CommitAlreadyLandedError"

  constructor(readonly version: DatasetVersion) {
    super(`[SixbSyncWorker] Version '${version.versionId}' already holds this run's rows.`)
  }
}

/**
 * Another writer moved the dataset between this run's guard and its commit. Nothing was written, so
 * the run stays running and the next delivery reads its source again.
 */
class CommitLostRaceError extends Error {
  override readonly name = "CommitLostRaceError"
}

function createBookkeepingError(options: {
  syncId: string
  runId: string
  version: DatasetVersion
  cause: unknown
}): Error {
  // The lake commit is already durable here: the run stays running, and the next delivery finds it.
  return createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync '${options.syncId}' committed dataset version '${options.version.versionId}', but failed to finalize sync run '${options.runId}'.`,
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
 * Run what is left of one Sync run this delivery holds, and record how it ended.
 *
 * Dispatch owns identity and queueing, and the worker owns the claim. A run reads its whole source
 * into one lake commit, so what is left is either that commit, from the last succeeded run's
 * checkpoint, or nothing but its record: a run that resumes asks the lake which.
 *
 * A stopped worker writes nothing here: the run stays running, and the next delivery takes it up.
 */
export async function runSyncJob(input: RunSyncJobInput): Promise<SyncRunResult> {
  const { runtime, claim } = input
  const { run } = claim
  const executionToken = claim.execution.token
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

  if (claim.outcome === "started") await input.onRunStarted?.(run)

  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "sync",
    id: job.id,
  })
  const logger = logSession.logger
  let rowsRead = 0
  let nextCheckpoint: JsonValue | undefined
  let committedVersion: DatasetVersion | undefined

  /** When this run first reached a commit: the earliest a version of it can have landed. */
  let commitPreparedAt = run.commitPreparedAt
  /** Whether a commit of this very execution is the one that may have landed. */
  let reachedCommit = false

  /** The lake and the run agree from here: what is left is only telling others. */
  const finishSucceeded = async (
    result: LandedRead & {
      readonly version: DatasetVersion | null | undefined
      readonly versionCreated: boolean
    }
  ): Promise<SyncRunResult> => {
    const { version, versionCreated } = result
    let finishedRun: SyncRunRecord

    try {
      finishedRun = await syncRunsStorage.finish({
        projectId: runtime.id,
        id: job.id,
        executionToken,
        status: "succeeded",
        rowsRead: result.rowsRead,
        ...(version
          ? { output: { datasetId: version.datasetId, versionId: version.versionId } }
          : {}),
        checkpoint: result.checkpoint,
      })
    } catch (error) {
      if (committedVersion) {
        throw createBookkeepingError({
          syncId: run.syncId,
          runId: job.id,
          version: committedVersion,
          cause: error,
        })
      }
      throw error
    }

    const finishedAt = requireFinishedAt({
      syncId: run.syncId,
      runId: job.id,
      finishedAt: finishedRun.finishedAt,
    })
    await notifyRunFinished(input.onRunFinished, finishedRun, committedVersion)

    const summary = {
      id: job.id,
      syncId: run.syncId,
      datasetId: run.datasetId,
      mode: run.mode,
      startedAt: requireStartedAt(job.id, run.startedAt),
      finishedAt,
      rowsRead: result.rowsRead,
    }
    return version ? { ...summary, version, versionCreated } : { ...summary, versionCreated: false }
  }

  /** Records a commit this run made, with what the execution that made it read. */
  const finishLanded = (version: DatasetVersion, read: LandedRead) =>
    finishSucceeded({ version, versionCreated: true, ...read })

  // Only an execution holding the run could prepare a commit, so none has moved these since.
  const readByEarlierExecution: LandedRead = {
    rowsRead: run.rowsRead ?? 0,
    checkpoint: run.checkpoint,
  }

  try {
    if (claim.outcome === "resumed") {
      const landed = await findLandedCommit(input, commitPreparedAt)
      if (landed) {
        committedVersion = landed
        return await finishLanded(landed, readByEarlierExecution)
      }
    }

    if (claim.givenUp) throw claim.givenUp

    const sync = requireSync(runtime, run)

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
    nextCheckpoint =
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

    // A crash right after the commit would lose the checkpoint it paid for, so it goes first. A
    // stale execution stops here; one that slept past this point meets the guard.
    const prepareCommit = async () => {
      const landed = await findLandedCommit(input, commitPreparedAt)
      if (landed) throw new CommitAlreadyLandedError(landed)

      const prepared = await syncRunsStorage.prepareCommit({
        projectId: runtime.id,
        id: job.id,
        executionToken,
        rowsRead,
        checkpoint: nextCheckpoint,
      })

      commitPreparedAt ??= prepared.commitPreparedAt
      reachedCommit = true
    }

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
      guardLatestVersion: true,
      beforeCommit: () => prepareCommit(),
    })
    if (outcome === "created") {
      committedVersion = version
    }

    return await finishSucceeded({
      version,
      versionCreated: outcome === "created",
      rowsRead,
      checkpoint: nextCheckpoint,
    })
  } catch (caught) {
    // A commit can land and still answer with an error, so only the lake can say what happened. If
    // it cannot say either, this throws, and the run stays open for the next delivery to ask.
    const landed = committedVersion
      ? null
      : await landedCommitBehind(input, caught, commitPreparedAt)

    if (landed) {
      committedVersion = landed
      const lostItsRace = caught instanceof LakeConcurrencyError
      const own = reachedCommit && !lostItsRace && !(caught instanceof CommitAlreadyLandedError)

      return await finishLanded(
        landed,
        own ? { rowsRead, checkpoint: nextCheckpoint } : readByEarlierExecution
      )
    }

    const error = translateLostRace(run, caught)

    if (!committedVersion && !signal.aborted && !(error instanceof CommitLostRaceError)) {
      // The shared writer has already cleaned up its session. Finalize the failed sync run.
      try {
        const failure = captureSixbFailure(
          translateSyncExecutionError(error, {
            syncId: run.syncId,
            runId: job.id,
            datasetId: run.datasetId,
          }),
          {
            allowedCodes: SYNC_RUN_FAILURE_CODES,
            defaultCode: "internal.unexpected",
            details: { syncId: run.syncId, runId: job.id, datasetId: run.datasetId },
          }
        )
        const failedRun = await syncRunsStorage.finish({
          projectId: runtime.id,
          id: job.id,
          executionToken,
          status: "failed",
          rowsRead,
          error: failure,
        })
        await notifyRunFinished(input.onRunFinished, failedRun)
        input.onRunFailed?.(error, failedRun, failure)
      } catch {
        // The run did not transition: a later delivery, or the execution that holds it, ends it.
      }
    }

    throw error
  } finally {
    await logSession.flush()
  }
}

function requireSync(runtime: RunSyncJobInput["runtime"], run: SyncRunRecord): SyncDefinition {
  const sync = runtime.syncs.getById(run.syncId)
  if (!sync) {
    throw new Error(`[SixbSyncWorker] Unknown sync '${run.syncId}'.`)
  }
  if (sync.target.dataset.id !== run.datasetId || sync.config.mode !== run.mode) {
    throw new Error(
      `[SixbSyncWorker] Sync run '${run.id}' no longer matches Sync '${sync.id}' configuration.`
    )
  }

  return sync
}

/** The commit an error says landed, or that the lake holds in spite of the error. */
async function landedCommitBehind(
  input: RunSyncJobInput,
  error: unknown,
  commitPreparedAt: Date | undefined
): Promise<DatasetVersion | null> {
  if (error instanceof CommitAlreadyLandedError) return error.version

  return findLandedCommit(input, commitPreparedAt)
}

/** A guard this run asked for failed on purpose. Its own guard only lost to another writer. */
function translateLostRace(run: SyncRunRecord, error: unknown): unknown {
  if (!(error instanceof LakeConcurrencyError) || run.expectedLatestVersionId !== undefined) {
    return error
  }

  return new CommitLostRaceError(`[SixbSyncWorker] Sync run '${run.id}' lost its commit race.`, {
    cause: error,
  })
}

/**
 * The version this run committed, if one did. A run that never prepared a commit has none: nothing
 * of a partial run exists until then, rows stay in a session no reader sees, and it need not ask.
 */
async function findLandedCommit(
  input: RunSyncJobInput,
  commitPreparedAt: Date | undefined
): Promise<DatasetVersion | null> {
  if (!commitPreparedAt) return null

  const { run } = input.claim

  return findProducedVersion({
    lakeStorage: input.runtime.lakeStorage,
    datasetId: run.datasetId,
    producer: { kind: "sync", runId: run.id },
    since: commitPreparedAt,
  })
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
