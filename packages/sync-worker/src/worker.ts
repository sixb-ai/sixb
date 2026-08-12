import type { DomainEventLog, LakeStorage, Queues, SixbDefinitions, Storage } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindPrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "@sixb/core/queues"
import { SYNC_RUN_FAILURE_CODES, type SyncRunRecord, type SyncRunStatus } from "@sixb/core/storage"
import { runSyncJob, SyncRunAlreadyStartedError } from "./run-sync-job"
import type { SyncJob, SyncWorkerContext } from "./types"

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
    const syncJob: SyncJob = {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      syncId: job.payload.syncId,
      expectedLatestVersionId: job.payload.expectedLatestVersionId,
      commitMessage: job.payload.commitMessage,
    }
    const execution = bindPrimitiveExecution(this.host, {
      primitive: { kind: "sync", id: syncJob.syncId, runId: syncJob.id },
      source: { type: "queue", queue: "syncRuns", jobId: job.id },
    })
    const context = buildSyncContext(this.host, execution.sixb)

    try {
      await runSyncJob({
        runtime: context,
        job: syncJob,
        signal,
        onRunStarted: (run) => emitSyncRunStarted(this.host, run),
        onRunFinished: (run, createdVersion) =>
          emitSyncRunFinishedEvents(this.host, run, createdVersion),
        onRunFailed: (error, run) => {
          reportRunFailure(this.host, error, {
            projectId: this.host.id,
            occurredAt: run.finishedAt,
            attempt: job.attempt,
            run: {
              kind: "sync",
              runId: run.id,
              syncId: run.syncId,
            },
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
  run: Pick<SyncRunRecord, "id" | "syncId" | "startedAt">
): Promise<void> {
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
    },
    { source: SOURCE }
  )
}

async function emitSyncRunFinishedEvents(
  host: SyncWorkerHost,
  run: Pick<SyncRunRecord, "id" | "syncId" | "datasetId" | "status" | "output" | "error">,
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
    },
    { source: SOURCE }
  )
}

function requireTerminalStatus(
  status: SyncRunStatus,
  context: string
): Exclude<SyncRunStatus, "running"> {
  if (status === "running") {
    throw new Error(`[SixbSyncWorker] ${context} is still running.`)
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
  sixb: ReturnType<typeof bindPrimitiveExecution>["sixb"]
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
