import type {
  BlobsRuntime,
  ConnectorRuntime,
  DatasetsRuntime,
  DomainEventLog,
  LakeStorage,
  Queues,
  Storage,
  SyncsRuntime,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "@sixb/core/queues"
import type { SyncRunRecord } from "@sixb/core/storage"
import { runSyncJob, SyncRunAlreadyStartedError } from "./run-sync-job"
import type { SyncJob, SyncRunResult, SyncWorkerContext } from "./types"

const SOURCE = "SixbSyncWorker"

export interface SyncWorkerSixb {
  readonly id: string
  readonly events?: DomainEventLog
  readonly logs?: LogsRuntime
  readonly lakeStorage: LakeStorage
  readonly blobs: Pick<BlobsRuntime, "put" | "open" | "stat">
  readonly queues: Queues
  readonly storage: Storage
  readonly syncs: Pick<SyncsRuntime, "list" | "getById">
  readonly datasets: Pick<DatasetsRuntime, "getById">
  readonly connector: ConnectorRuntime
}

export class SyncWorker extends QueueWorker<SyncRunRequestedQueueJob> {
  private readonly context: SyncWorkerContext
  private readonly sixb: SyncWorkerSixb

  constructor(sixb: SyncWorkerSixb) {
    if (sixb.syncs.list().length === 0) {
      throw new Error("[SixbSyncWorker] No sync definitions are registered.")
    }

    super({
      projectId: sixb.id,
      queue: sixb.queues.syncRuns,
      workerId: `sync-worker-${sixb.id}`,
    })

    this.context = buildSyncContext(sixb)
    this.sixb = sixb
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

    let result: SyncRunResult
    try {
      result = await runSyncJob({
        runtime: this.context,
        job: syncJob,
        signal,
        onRunStarted: (run) => emitSyncRunStarted(this.sixb, run),
        onRunFailed: (error, run) => {
          reportRunFailure(this.sixb, error, {
            projectId: this.sixb.id,
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

    await emitSyncSucceededEvents(this.sixb, syncJob, result)
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const { job } = claimed
    await emitSyncRunFinished(this.sixb, {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      syncId: job.payload.syncId,
    })

    return { kind: "fail" }
  }
}

async function emitSyncRunStarted(
  sixb: SyncWorkerSixb,
  run: Pick<SyncRunRecord, "id" | "syncId" | "startedAt">
): Promise<void> {
  await sixb.events?.emit(
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
  sixb: SyncWorkerSixb,
  job: Pick<SyncJob, "id" | "syncId">,
  result: SyncRunResult
): Promise<void> {
  await sixb.events?.emit(
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
  sixb: SyncWorkerSixb,
  job: Pick<SyncJob, "id" | "syncId">
): Promise<void> {
  await sixb.events?.emit(
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

function buildSyncContext(sixb: SyncWorkerSixb): SyncWorkerContext {
  const syncRunsStorage = sixb.storage.syncRuns
  if (!syncRunsStorage) {
    throw new Error("[SixbSyncWorker] Sync workers require storage.syncRuns support.")
  }

  return {
    id: sixb.id,
    syncRunsStorage,
    lakeStorage: sixb.lakeStorage,
    blobs: sixb.blobs,
    logs: sixb.logs,
    syncs: sixb.syncs,
    datasets: sixb.datasets,
    connector: sixb.connector,
  }
}
