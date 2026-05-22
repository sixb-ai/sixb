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
} from "@pario/core"
import { QueueWorker } from "@pario/core"
import { runSyncJob } from "./run-sync-job"
import type { SyncJob, SyncRunResult, SyncWorkerContext } from "./types"

export interface SyncWorkerPario {
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
  private readonly pario: SyncWorkerPario

  constructor(pario: SyncWorkerPario) {
    if (pario.getSyncDefinitions().length === 0) {
      throw new Error("[ParioSyncWorker] No sync definitions are registered.")
    }

    super({
      projectId: pario.id,
      queue: pario.queues.syncRuns,
      workerId: `sync-worker-${pario.id}`,
    })

    this.context = buildSyncContext(pario)
    this.pario = pario
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
      onRunStarted: (run) => emitSyncRunStarted(this.pario, run),
    })

    await emitSyncSucceededEvents(this.pario, syncJob, result)
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const { job } = claimed
    await emitSyncRunFinished(this.pario, {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      syncId: job.payload.syncId,
    })

    return { kind: "fail" }
  }
}

async function emitSyncRunStarted(
  pario: SyncWorkerPario,
  run: Pick<SyncRunRecord, "id" | "syncId" | "startedAt">
): Promise<void> {
  if (!pario.events) return
  try {
    await pario.events.append({
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
    console.error("[ParioSyncWorker] Failed to emit sync.run.started:", error)
  }
}

async function emitSyncSucceededEvents(
  pario: SyncWorkerPario,
  job: Pick<SyncJob, "id" | "syncId">,
  result: SyncRunResult
): Promise<void> {
  if (!pario.events) return
  try {
    await pario.events.append({
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
    console.error("[ParioSyncWorker] Failed to emit sync success events:", error)
  }
}

async function emitSyncRunFinished(
  pario: SyncWorkerPario,
  job: Pick<SyncJob, "id" | "syncId">
): Promise<void> {
  if (!pario.events) return
  try {
    await pario.events.append({
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
    console.error("[ParioSyncWorker] Failed to emit sync.run.finished:", error)
  }
}

function buildSyncContext(pario: SyncWorkerPario): SyncWorkerContext {
  const syncRunsStorage = pario.storage.syncRuns
  if (!syncRunsStorage) {
    throw new Error("[ParioSyncWorker] Sync workers require storage.syncRuns support.")
  }

  return {
    id: pario.id,
    syncRunsStorage,
    lakeStorage: pario.lakeStorage,
    blobStorage: pario.blobStorage,
    getSyncById(syncId) {
      return pario.getSyncById(syncId)
    },
    getDatasetById(datasetId) {
      return pario.getDatasetById(datasetId)
    },
    connector(definition) {
      return pario.connector(definition)
    },
  }
}
