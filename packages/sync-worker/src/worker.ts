import type { DomainEventLog, LakeStorage, Queues, SixbDefinitions, Storage } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "@sixb/core/queues"
import { SYNC_RUN_FAILURE_CODES, type SyncRunRecord, type SyncRunStatus } from "@sixb/core/storage"
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

export class SyncWorker extends QueueWorker<
  SyncRunRequestedQueueJob,
  typeof SYNC_RUN_FAILURE_CODES
> {
  private readonly host: SyncWorkerHost

  constructor(host: SyncWorkerHost) {
    if (host.definitions.syncs.list().length === 0) {
      throw new Error("[SixbSyncWorker] No sync definitions are registered.")
    }

    super({
      projectId: host.id,
      queue: host.queues.syncRuns,
      failureCodes: SYNC_RUN_FAILURE_CODES,
      workerId: `sync-worker-${host.id}`,
    })

    assertSyncStorage(host)
    this.host = host
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
    connector: sixb.connector,
  }
}
