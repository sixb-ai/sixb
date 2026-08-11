import type {
  DatasetsRuntime,
  DomainEventLog,
  LakeStorage,
  Queues,
  Storage,
  SyncsRuntime,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import {
  bindPrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "@sixb/core/queues"
import type { SyncRunRecord } from "@sixb/core/storage"
import { runSyncJob, SyncRunAlreadyStartedError } from "./run-sync-job"
import type { SyncJob, SyncRunResult, SyncWorkerContext } from "./types"

const SOURCE = "SixbSyncWorker"

export interface SyncWorkerHost extends PrimitiveExecutionHost {
  readonly events?: DomainEventLog
  readonly logs?: LogsRuntime
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly storage: Storage
  readonly syncs: Pick<SyncsRuntime, "list" | "getById">
  readonly datasets: Pick<DatasetsRuntime, "getById">
}

export class SyncWorker extends QueueWorker<SyncRunRequestedQueueJob> {
  private readonly host: SyncWorkerHost

  constructor(host: SyncWorkerHost) {
    if (host.syncs.list().length === 0) {
      throw new Error("[SixbSyncWorker] No sync definitions are registered.")
    }

    super({
      projectId: host.id,
      queue: host.queues.syncRuns,
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

    let result: SyncRunResult
    try {
      result = await runSyncJob({
        runtime: context,
        job: syncJob,
        signal,
        onRunStarted: (run) => emitSyncRunStarted(this.host, run),
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

    await emitSyncSucceededEvents(this.host, syncJob, result)
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const { job } = claimed
    await emitSyncRunFinished(this.host, {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      syncId: job.payload.syncId,
    })

    return { kind: "fail" }
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

async function emitSyncSucceededEvents(
  host: SyncWorkerHost,
  job: Pick<SyncJob, "id" | "syncId">,
  result: SyncRunResult
): Promise<void> {
  await host.events?.emit(
    {
      events: [
        ...(result.versionCreated
          ? [
              {
                type: "dataset.version.committed" as const,
                payload: {
                  datasetId: result.datasetId,
                  versionId: result.version.versionId,
                  createdAt: result.version.createdAt.toISOString(),
                  producer: {
                    kind: "sync" as const,
                    id: job.syncId,
                    runId: job.id,
                  },
                },
              },
            ]
          : []),
        {
          type: "sync.run.finished",
          payload: {
            syncId: job.syncId,
            runId: job.id,
            status: "succeeded",
            datasetId: result.datasetId,
            ...(result.version ? { versionId: result.version.versionId } : {}),
          },
        },
      ],
    },
    { source: SOURCE }
  )
}

async function emitSyncRunFinished(
  host: SyncWorkerHost,
  job: Pick<SyncJob, "id" | "syncId">
): Promise<void> {
  await host.events?.emit(
    {
      events: [
        {
          type: "sync.run.finished",
          payload: {
            syncId: job.syncId,
            runId: job.id,
            status: "failed",
          },
        },
      ],
    },
    { source: SOURCE }
  )
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
    logs: host.logs,
    syncs: host.syncs,
    datasets: host.datasets,
    connector: sixb.connector,
  }
}
