import {
  cloneJsonValue,
  type DatasetDefinition,
  type JsonValue,
  type Logger,
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

/** What one execution of a run learns as it goes, for the steps below to record. */
interface SyncExecution {
  readonly input: RunSyncJobInput
  readonly run: SyncRunRecord
  readonly signal: AbortSignal
  rowsRead: number
  nextCheckpoint: JsonValue | undefined
  /** The version this execution knows the run has, once the lake and the run agree on it. */
  committedVersion: DatasetVersion | undefined
  /** When this run first reached a commit: the earliest a version of it can have landed. */
  commitPreparedAt: Date | undefined
  /** Whether a commit of this very execution is the one that may have landed. */
  reachedCommit: boolean
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
  const signal = input.signal ?? new AbortController().signal

  if (run.projectId !== runtime.id) {
    throw new Error(
      `[SixbSyncWorker] Sync run '${run.id}' belongs to project '${run.projectId}', not '${runtime.id}'.`
    )
  }

  throwIfAborted(signal)

  if (claim.outcome === "started") await input.onRunStarted?.(run)

  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "sync",
    id: run.id,
  })

  const execution: SyncExecution = {
    input,
    run,
    signal,
    rowsRead: 0,
    nextCheckpoint: undefined,
    committedVersion: undefined,
    commitPreparedAt: run.commitPreparedAt,
    reachedCommit: false,
  }

  try {
    if (claim.outcome === "resumed") {
      const landed = await findLandedCommit(execution)
      if (landed) return await finishLanded(execution, landed, readByEarlierExecution(run))
    }

    if (claim.givenUp) throw claim.givenUp

    return await commitRun(execution, logSession.logger)
  } catch (caught) {
    return await settleFailure(execution, caught)
  } finally {
    await logSession.flush()
  }
}

/** Reads the source from the last succeeded run's checkpoint into one commit. */
async function commitRun(execution: SyncExecution, logger: Logger): Promise<SyncRunResult> {
  const { run, signal } = execution
  const { runtime } = execution.input
  const { lakeStorage, blobs: blobStorage } = runtime

  const sync = requireSync(runtime, run)
  const dataset = requireDataset(runtime, sync, run)

  const previousCheckpoint = await readPreviousCheckpoint(runtime, sync)
  execution.nextCheckpoint = cloneCheckpoint(previousCheckpoint)

  const { outcome, version } = await writeDataset({
    lakeStorage,
    blobStorage,
    dataset,
    mode: sync.config.mode,
    signal,
    producer: { kind: "sync", id: sync.id, runId: run.id },
    readValues: () =>
      readSyncValues({
        runtime,
        sync,
        runId: run.id,
        datasetId: dataset.id,
        signal,
        blobStorage,
        logger,
        previousCheckpoint,
        setCheckpoint(next) {
          execution.nextCheckpoint = cloneCheckpoint(next)
        },
      }),
    expectedLatestVersionId: run.expectedLatestVersionId,
    commitMessage: run.commitMessage ?? `sync ${sync.id} run ${run.id}`,
    sourceLabel: `[SixbSyncWorker] Sync '${sync.id}'`,
    onRead(count) {
      execution.rowsRead = count
    },
    mapValidationError: (error, value, itemIndex) =>
      sourceValidationError(error, value, { syncId: sync.id, runId: run.id, dataset }, itemIndex),
    guardLatestVersion: true,
    beforeCommit: () => prepareCommit(execution),
  })

  if (outcome === "created") execution.committedVersion = version

  return finishSucceeded(execution, {
    version,
    versionCreated: outcome === "created",
    rowsRead: execution.rowsRead,
    checkpoint: execution.nextCheckpoint,
  })
}

/**
 * A crash right after the commit would lose the checkpoint it paid for, so it goes first. A stale
 * execution stops here; one that slept past this point meets the guard.
 */
async function prepareCommit(execution: SyncExecution): Promise<void> {
  const { run } = execution
  const { runtime, claim } = execution.input

  const landed = await findLandedCommit(execution)
  if (landed) throw new CommitAlreadyLandedError(landed)

  const prepared = await runtime.syncRunsStorage.prepareCommit({
    projectId: runtime.id,
    id: run.id,
    executionToken: claim.execution.token,
    rowsRead: execution.rowsRead,
    checkpoint: execution.nextCheckpoint,
  })

  execution.commitPreparedAt ??= prepared.commitPreparedAt
  execution.reachedCommit = true
}

/** The lake and the run agree from here: what is left is only telling others. */
async function finishSucceeded(
  execution: SyncExecution,
  result: LandedRead & {
    readonly version: DatasetVersion | null | undefined
    readonly versionCreated: boolean
  }
): Promise<SyncRunResult> {
  const { run, committedVersion } = execution
  const { version, versionCreated, rowsRead } = result

  const finished = await recordSucceeded(execution, result)

  const finishedAt = requireFinishedAt({
    syncId: run.syncId,
    runId: run.id,
    finishedAt: finished.finishedAt,
  })

  await notifyRunFinished(execution.input.onRunFinished, finished, committedVersion)

  const summary = {
    id: run.id,
    syncId: run.syncId,
    datasetId: run.datasetId,
    mode: run.mode,
    startedAt: requireStartedAt(run.id, run.startedAt),
    finishedAt,
    rowsRead,
  }

  return version ? { ...summary, version, versionCreated } : { ...summary, versionCreated: false }
}

async function recordSucceeded(
  execution: SyncExecution,
  result: LandedRead & { readonly version: DatasetVersion | null | undefined }
): Promise<SyncRunRecord> {
  const { run, committedVersion } = execution
  const { runtime, claim } = execution.input
  const { version, rowsRead, checkpoint } = result

  try {
    return await runtime.syncRunsStorage.finish({
      projectId: runtime.id,
      id: run.id,
      executionToken: claim.execution.token,
      status: "succeeded",
      rowsRead,
      ...(version
        ? { output: { datasetId: version.datasetId, versionId: version.versionId } }
        : {}),
      checkpoint,
    })
  } catch (error) {
    if (!committedVersion) throw error

    throw createBookkeepingError({
      syncId: run.syncId,
      runId: run.id,
      version: committedVersion,
      cause: error,
    })
  }
}

/** Records a commit this run made, with what the execution that made it read. */
function finishLanded(
  execution: SyncExecution,
  version: DatasetVersion,
  read: LandedRead
): Promise<SyncRunResult> {
  execution.committedVersion = version

  return finishSucceeded(execution, { version, versionCreated: true, ...read })
}

/** Only an execution holding the run could prepare a commit, so none has moved these since. */
function readByEarlierExecution(run: SyncRunRecord): LandedRead {
  return { rowsRead: run.rowsRead ?? 0, checkpoint: run.checkpoint }
}

/**
 * A commit can land and still answer with an error, so only the lake can say what happened. If it
 * cannot say either, this throws, and the run stays open for the next delivery to ask.
 */
async function settleFailure(execution: SyncExecution, caught: unknown): Promise<SyncRunResult> {
  const { run, signal, committedVersion } = execution

  const landed = committedVersion ? null : await landedCommitBehind(execution, caught)
  if (landed) return finishLanded(execution, landed, landedRead(execution, caught))

  const error = translateLostRace(run, caught)

  if (!committedVersion && !signal.aborted && !(error instanceof CommitLostRaceError)) {
    await recordFailed(execution, error)
  }

  throw error
}

/** What the execution behind a landed commit read: this one, if the commit is its own. */
function landedRead(execution: SyncExecution, caught: unknown): LandedRead {
  const lostItsRace = caught instanceof LakeConcurrencyError
  const own =
    execution.reachedCommit && !lostItsRace && !(caught instanceof CommitAlreadyLandedError)

  return own
    ? { rowsRead: execution.rowsRead, checkpoint: execution.nextCheckpoint }
    : readByEarlierExecution(execution.run)
}

/** The shared writer has already cleaned up its session. Finalize the failed sync run. */
async function recordFailed(execution: SyncExecution, error: unknown): Promise<void> {
  const { run, rowsRead } = execution
  const { runtime, claim, onRunFinished, onRunFailed } = execution.input

  try {
    const failure = captureSixbFailure(
      translateSyncExecutionError(error, {
        syncId: run.syncId,
        runId: run.id,
        datasetId: run.datasetId,
      }),
      {
        allowedCodes: SYNC_RUN_FAILURE_CODES,
        defaultCode: "internal.unexpected",
        details: { syncId: run.syncId, runId: run.id, datasetId: run.datasetId },
      }
    )

    const failedRun = await runtime.syncRunsStorage.finish({
      projectId: runtime.id,
      id: run.id,
      executionToken: claim.execution.token,
      status: "failed",
      rowsRead,
      error: failure,
    })

    await notifyRunFinished(onRunFinished, failedRun)
    onRunFailed?.(error, failedRun, failure)
  } catch {
    // The run did not transition: a later delivery, or the execution that holds it, ends it.
  }
}

function cloneCheckpoint(checkpoint: JsonValue | undefined): JsonValue | undefined {
  return checkpoint === undefined ? undefined : cloneJsonValue(checkpoint)
}

async function readPreviousCheckpoint(
  runtime: RunSyncJobInput["runtime"],
  sync: SyncDefinition
): Promise<JsonValue | undefined> {
  const { runs } = await runtime.syncRunsStorage.list({
    projectId: runtime.id,
    syncId: sync.id,
    statuses: ["succeeded"],
    limit: 1,
    order: "desc",
  })

  return runs[0]?.checkpoint
}

function requireDataset(
  runtime: RunSyncJobInput["runtime"],
  sync: SyncDefinition,
  run: SyncRunRecord
): DatasetDefinition {
  const dataset = runtime.datasets.getById(run.datasetId)
  if (dataset) return dataset

  throw new Error(`[SixbSyncWorker] Sync '${sync.id}' targets unknown dataset '${run.datasetId}'.`)
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
  execution: SyncExecution,
  error: unknown
): Promise<DatasetVersion | null> {
  if (error instanceof CommitAlreadyLandedError) return error.version

  return findLandedCommit(execution)
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
async function findLandedCommit(execution: SyncExecution): Promise<DatasetVersion | null> {
  const { run, commitPreparedAt, input } = execution
  if (!commitPreparedAt) return null

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
