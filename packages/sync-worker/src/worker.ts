import type {
  DomainEventLog,
  LakeStorage,
  Queues,
  SixbDefinitions,
  SixbFailure,
  Storage,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import { getLakeRetentionRuntime } from "@sixb/core/internal/runtime"
import { resolveSyncConnectorSources } from "@sixb/core/internal/syncs"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker, retryUnstartedRun } from "@sixb/core/internal/workers"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "@sixb/core/queues"
import {
  SYNC_RUN_FAILURE_CODES,
  type SyncRunFailureCode,
  type SyncRunRecord,
  type SyncRunStatus,
} from "@sixb/core/storage"
import { LakeWorker } from "./lake-worker"
import { runSyncJob, SyncRunAlreadyStartedError } from "./run-sync-job"
import type { SyncWorkerContext } from "./types"

const SOURCE = "SixbSyncWorker"

export interface SyncWorkerHost extends PrimitiveExecutionHost {
  readonly events?: DomainEventLog
  readonly logging?: LoggingService
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly storage: Storage
  readonly definitions: Pick<SixbDefinitions, "syncs" | "datasets">
}

export interface SyncWorkerOptions {
  /** Maximum sync run jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
}

export class SyncWorker extends QueueWorker<
  SyncRunRequestedQueueJob,
  typeof SYNC_RUN_FAILURE_CODES
> {
  private readonly host: SyncWorkerHost
  private readonly lakeWorker?: LakeWorker

  constructor(host: SyncWorkerHost, options: SyncWorkerOptions = {}) {
    const lakeRetention = getLakeRetentionRuntime(host).automatic
    if (host.definitions.syncs.list().length === 0 && !lakeRetention) {
      throw new Error(
        "[SixbSyncWorker] No sync definitions are registered, and lake retention is not scheduled."
      )
    }

    super({
      projectId: host.id,
      queue: host.queues.syncRuns,
      failureCodes: SYNC_RUN_FAILURE_CODES,
      workerId: `sync-worker-${host.id}`,
      claimLimit: options.concurrency,
    })

    assertSyncStorage(host)
    this.host = host
    if (lakeRetention) this.lakeWorker = new LakeWorker(host)
  }

  override async start(): Promise<void> {
    await Promise.all([super.start(), this.lakeWorker?.start()])
  }

  override async stop(): Promise<void> {
    await Promise.all([super.stop(), this.lakeWorker?.stop()])
  }

  override async wait(): Promise<void> {
    await Promise.all([super.wait(), this.lakeWorker?.wait()])
  }

  protected async execute(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { job } = claimed
    const syncRuns = this.host.storage.syncRuns
    if (!syncRuns) {
      throw new Error("[SixbSyncWorker] Sync workers require storage.syncRuns support.")
    }
    const run = await syncRuns.getById({ projectId: this.host.id, id: job.payload.runId })
    if (!run) {
      throw new Error(`[SixbSyncWorker] Sync run '${job.payload.runId}' was not found.`)
    }

    // Each trigger that joined this run published its own job for it. Once one of them has started
    // the run, the others have nothing left to do.
    if (run.status !== "queued") return

    const durableExecution = await this.host.storage.executions.getById({
      projectId: this.host.id,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw new Error(
        `[SixbSyncWorker] Sync run '${run.id}' references missing execution '${run.executionId}'.`
      )
    }

    const execution = bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: { kind: "sync", id: run.syncId, runId: run.id },
    })
    const context = buildSyncContext(this.host, execution.sixb)

    try {
      await runSyncJob({
        runtime: context,
        run,
        signal,
        onRunStarted: (started) =>
          emitSyncRunStarted(this.host, started, durableExecution.correlationId),
        onRunFinished: (finished, createdVersion) =>
          emitSyncRunFinishedEvents(
            this.host,
            finished,
            durableExecution.correlationId,
            createdVersion
          ),
        onRunFailed: (error, run, failure) => {
          reportRunFailure(this.host, error, {
            projectId: this.host.id,
            attempt: job.attempt,
            runKind: "sync",
            run: {
              runId: run.id,
              syncId: run.syncId,
            },
            failure,
          })
        },
      })
    } catch (error) {
      if (error instanceof SyncRunAlreadyStartedError) return
      throw error
    }
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof SYNC_RUN_FAILURE_CODES)[number]>> {
    const run = await this.host.storage.syncRuns?.getById({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
    })
    if (run?.status === "queued") {
      const retry = retryUnstartedRun(claimed.job.attempt)
      if (retry) return retry

      return { kind: "fail", failure: await this.failUnstartedRun(claimed, run, error) }
    }

    return run?.status === "failed" && run.error
      ? { kind: "fail", failure: run.error }
      : { kind: "fail" }
  }

  /**
   * Automatic dispatch joins a queued run instead of queueing another, so a run whose job ends
   * before starting it must not stay queued: every later trigger would wait on it forever.
   */
  private async failUnstartedRun(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    run: SyncRunRecord,
    error: unknown
  ): Promise<SixbFailure<SyncRunFailureCode>> {
    const syncRuns = this.host.storage.syncRuns
    if (!syncRuns) {
      throw new Error("[SixbSyncWorker] Sync workers require storage.syncRuns support.")
    }

    const failure = captureSixbFailure(error, {
      allowedCodes: SYNC_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      details: { syncId: run.syncId, runId: run.id, datasetId: run.datasetId },
    })

    await syncRuns.finish({
      projectId: this.host.id,
      id: run.id,
      status: "failed",
      error: failure,
    })

    reportRunFailure(this.host, error, {
      projectId: this.host.id,
      attempt: claimed.job.attempt,
      runKind: "sync",
      run: { runId: run.id, syncId: run.syncId },
      failure,
    })
    return failure
  }
}

async function emitSyncRunStarted(
  host: SyncWorkerHost,
  run: Pick<SyncRunRecord, "id" | "syncId" | "startedAt">,
  correlationId: string
): Promise<void> {
  if (!run.startedAt) {
    throw new Error(`[SixbSyncWorker] Sync run '${run.id}' started without a timestamp.`)
  }
  await host.events?.emit(
    {
      events: [
        {
          type: "sync.run.started",
          payload: {
            syncId: run.syncId,
            runId: run.id,
            startedAt: run.startedAt.toISOString(),
          },
        },
      ],
      correlationId,
    },
    { source: SOURCE }
  )
}

async function emitSyncRunFinishedEvents(
  host: SyncWorkerHost,
  run: Pick<SyncRunRecord, "id" | "syncId" | "datasetId" | "status" | "output" | "error">,
  correlationId: string,
  createdVersion?: DatasetVersion
): Promise<void> {
  // Sync owns notification after its run is finalized; the shared dataset writer returns the
  // created version but does not publish events. Durable delivery is a separate follow-up.
  await host.events?.emit(
    {
      events: [
        ...(createdVersion
          ? [
              {
                type: "dataset.version.committed" as const,
                payload: {
                  datasetId: createdVersion.datasetId,
                  versionId: createdVersion.versionId,
                  createdAt: createdVersion.createdAt.toISOString(),
                  producer: {
                    kind: "sync" as const,
                    id: run.syncId,
                    runId: run.id,
                  },
                  rowsChanged: createdVersion.rowsChanged,
                  lineageChanged: createdVersion.lineageChanged,
                },
              },
            ]
          : []),
        {
          type: "sync.run.finished",
          payload: {
            syncId: run.syncId,
            runId: run.id,
            status: requireTerminalStatus(run.status, `Sync run '${run.id}'`),
            datasetId: run.datasetId,
            ...(run.output ? { versionId: run.output.versionId } : {}),
            ...(run.error ? { error: run.error } : {}),
          },
        },
      ],
      correlationId,
    },
    { source: SOURCE }
  )
}

function requireTerminalStatus(
  status: SyncRunStatus,
  context: string
): Exclude<SyncRunStatus, "queued" | "running"> {
  if (status === "queued" || status === "running") {
    throw new Error(`[SixbSyncWorker] ${context} is not terminal.`)
  }

  return status
}

function assertSyncStorage(host: SyncWorkerHost): void {
  if (!host.storage.syncRuns) {
    throw new Error("[SixbSyncWorker] Sync workers require storage.syncRuns support.")
  }
}

function buildSyncContext(
  host: SyncWorkerHost,
  sixb: ReturnType<typeof bindDurablePrimitiveExecution>["sixb"]
): SyncWorkerContext {
  const syncRunsStorage = host.storage.syncRuns
  if (!syncRunsStorage) {
    throw new Error("[SixbSyncWorker] Sync workers require storage.syncRuns support.")
  }

  return {
    id: host.id,
    syncRunsStorage,
    lakeStorage: host.lakeStorage,
    blobs: sixb.blobs,
    logging: host.logging,
    syncs: host.definitions.syncs,
    datasets: host.definitions.datasets,
    connectorSources: {
      list: (definition) => resolveSyncConnectorSources(sixb.connector, definition),
    },
  }
}
