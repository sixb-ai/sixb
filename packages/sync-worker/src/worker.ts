import type { DomainEventLog, LakeStorage, Queues, SixbDefinitions, Storage } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import { resolveSyncConnectorSources } from "@sixb/core/internal/syncs"
import { type HeldRunClaim, RunWorker, wakeJobId } from "@sixb/core/internal/workers"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "@sixb/core/queues"
import {
  type RunClaim,
  type RunExecution,
  SYNC_RUN_FAILURE_CODES,
  type SyncRunRecord,
  type SyncRunStatus,
  type SyncRunStorage,
} from "@sixb/core/storage"
import { runSyncJob } from "./run-sync-job"
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

export class SyncWorker extends RunWorker<
  SyncRunRequestedQueueJob,
  typeof SYNC_RUN_FAILURE_CODES,
  SyncRunRecord
> {
  private readonly host: SyncWorkerHost

  constructor(host: SyncWorkerHost, options: SyncWorkerOptions = {}) {
    if (host.definitions.syncs.list().length === 0) {
      throw new Error("[SixbSyncWorker] No sync definitions are registered.")
    }

    super({
      projectId: host.id,
      queue: host.queues.syncRuns,
      failureCodes: SYNC_RUN_FAILURE_CODES,
      workerId: `sync-worker-${host.id}`,
      claimLimit: options.concurrency,
      runs: requireSyncRuns(host),
      executions: host.storage.executions,
    })

    this.host = host
  }

  protected claimRun(
    claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    execution: RunExecution
  ): Promise<RunClaim<SyncRunRecord>> {
    return requireSyncRuns(this.host).startOrReclaim({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
      execution,
    })
  }

  protected async executeRun(
    claim: HeldRunClaim<SyncRunRecord>,
    _claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { run } = claim

    const durableExecution = await this.requireExecution(run)

    const execution = bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: { kind: "sync", id: run.syncId, runId: run.id },
    })

    await runSyncJob({
      runtime: buildSyncContext(this.host, execution.sixb),
      claim,
      signal,
      onRunStarted: (started) =>
        emitSyncRunStarted(this.host, started, durableExecution.correlationId),
      onRunFinished: async (finished, createdVersion) => {
        await emitSyncRunFinishedEvents(
          this.host,
          finished,
          durableExecution.correlationId,
          createdVersion
        )
        await this.wakeNextRun(finished)
      },
      onRunFailed: (error, run, failure) => {
        reportRunFailure(this.host, error, {
          projectId: this.host.id,
          attempt: run.attempt,
          runKind: "sync",
          run: {
            runId: run.id,
            syncId: run.syncId,
          },
          failure,
        })
      },
    })
  }

  /** A run of a Sync that waited for this one need not wait for its next look. */
  private async wakeNextRun(finished: SyncRunRecord): Promise<void> {
    try {
      const { runs } = await requireSyncRuns(this.host).list({
        projectId: this.host.id,
        syncId: finished.syncId,
        statuses: ["queued"],
        order: "asc",
        limit: 1,
      })

      const [next] = runs
      if (!next) return

      await this.host.queues.syncRuns.enqueue({
        projectId: this.host.id,
        jobs: [
          {
            id: wakeJobId(next.id, finished.id),
            type: "sync.run.requested",
            payload: { runId: next.id },
          },
        ],
      })
    } catch (error) {
      // It looks again by itself, a little later.
      console.error(`[SixbSyncWorker] Could not wake the run after '${finished.id}'.`, error)
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
  // Sync owns notification after its run is finalized; the shared dataset writer returns the
  // created version but does not publish events. If these are lost, the `projections` and
  // `triggers` passes find the version in the lake.
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

function requireSyncRuns(host: SyncWorkerHost): SyncRunStorage {
  if (!host.storage.syncRuns) {
    throw new Error("[SixbSyncWorker] Sync workers require storage.syncRuns support.")
  }
  return host.storage.syncRuns
}

function buildSyncContext(
  host: SyncWorkerHost,
  sixb: ReturnType<typeof bindDurablePrimitiveExecution>["sixb"]
): SyncWorkerContext {
  return {
    id: host.id,
    syncRunsStorage: requireSyncRuns(host),
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
