import type {
  BlobStorage,
  ClaimedQueueJob,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  DatasetDefinition,
  EventsRuntime,
  LakeStorage,
  Queues,
  QueueWorkerFailureDecision,
  Storage,
  SyncDefinition,
  SyncRunRecord,
  SyncRunRequestedQueueJob,
} from "@sixb/core"
import { QueueWorker } from "@sixb/core"
import { runSyncJob } from "./run-sync-job"
import type { SyncJob, SyncRunResult, SyncWorkerContext } from "./types"

export interface SyncWorkerSixb {
  readonly id: string
  readonly events?: EventsRuntime
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly storage: Storage
  getSyncDefinitions(): readonly SyncDefinition[]
  getSyncById(syncId: string): SyncDefinition | null
  getDatasetById(datasetId: string): DatasetDefinition | null
  connector<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>
}

export class SyncWorker extends QueueWorker<SyncRunRequestedQueueJob> {
  private readonly context: SyncWorkerContext
  private readonly sixb: SyncWorkerSixb

  constructor(sixb: SyncWorkerSixb) {
    if (sixb.getSyncDefinitions().length === 0) {
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

    const result = await runSyncJob({
      runtime: this.context,
      job: syncJob,
      signal,
      onRunStarted: (run) => emitSyncRunStarted(this.sixb, run),
    })

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
  if (!sixb.events) return
  try {
    await sixb.events.append({
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
    })
  } catch (error) {
    console.error("[SixbSyncWorker] Failed to emit sync.run.started:", error)
  }
}

async function emitSyncSucceededEvents(
  sixb: SyncWorkerSixb,
  job: Pick<SyncJob, "id" | "syncId">,
  result: SyncRunResult
): Promise<void> {
  if (!sixb.events) return
  try {
    await sixb.events.append({
      events: [
        {
          type: "dataset.version.committed",
          payload: {
            datasetId: result.datasetId,
            versionId: result.version.versionId,
            producer: {
              kind: "sync",
              id: job.syncId,
              runId: job.id,
            },
          },
        },
        {
          type: "sync.run.finished",
          payload: {
            syncId: job.syncId,
            runId: job.id,
            status: "succeeded",
            datasetId: result.datasetId,
            versionId: result.version.versionId,
          },
        },
      ],
    })
  } catch (error) {
    console.error("[SixbSyncWorker] Failed to emit sync success events:", error)
  }
}

async function emitSyncRunFinished(
  sixb: SyncWorkerSixb,
  job: Pick<SyncJob, "id" | "syncId">
): Promise<void> {
  if (!sixb.events) return
  try {
    await sixb.events.append({
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
    })
  } catch (error) {
    console.error("[SixbSyncWorker] Failed to emit sync.run.finished:", error)
  }
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
    blobStorage: sixb.blobStorage,
    getSyncById(syncId) {
      return sixb.getSyncById(syncId)
    },
    getDatasetById(datasetId) {
      return sixb.getDatasetById(datasetId)
    },
    connector(definition) {
      return sixb.connector(definition)
    },
  }
}
