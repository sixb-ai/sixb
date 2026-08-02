import { MaterializationCancellationError } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { shareProjectionRegistry } from "@sixb/core/internal/projections"
import { shareOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, ProjectionRunRequestedQueueJob } from "@sixb/core/queues"
import type { ProjectionRunStorage } from "@sixb/core/storage"
import { projectionRetryAvailableAt } from "./retry-backoff"
import { isPermanentProjectionFailure, runProjectionJob } from "./run-projection-job"
import type { ProjectionWorkerContext, ProjectionWorkerSixb } from "./types"

export class ProjectionWorker extends QueueWorker<ProjectionRunRequestedQueueJob> {
  private readonly context: ProjectionWorkerContext
  private readonly sixb: ProjectionWorkerSixb

  constructor(sixb: ProjectionWorkerSixb) {
    const projectionCount =
      sixb.listObjectProjections().length +
      sixb.listLinkProjections().length +
      sixb.listTelemetryProjections().length
    if (projectionCount === 0) {
      throw new Error("[SixbProjectionWorker] No projection definitions are registered.")
    }

    const projectionRunsStorage = sixb.storage.projectionRuns
    if (!projectionRunsStorage) {
      throw new Error("[SixbProjectionWorker] Projection workers require storage.projectionRuns.")
    }

    super({
      projectId: sixb.projectId,
      queue: sixb.queues.projections,
      workerId: `projection-worker-${sixb.id}`,
      host: sixb,
    })
    this.context = buildProjectionContext(sixb, projectionRunsStorage)
    this.sixb = sixb
  }

  protected async execute(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { job } = claimed
    await runProjectionJob({
      runtime: this.context,
      job: { id: job.id, ...job.payload },
      signal,
      onRunFailed: (error, run) => {
        reportRunFailure(this.sixb, error, {
          projectId: this.sixb.projectId,
          occurredAt: run.finishedAt,
          attempt: job.attempt,
          run: {
            kind: "projection",
            runId: run.id,
            projectionId: run.identity.projectionId,
            projectionKind: run.identity.projectionKind,
          },
        })
      },
    })
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return this.failureDecision(claimed, error)
  }

  protected override async onAbortError(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    if (error instanceof MaterializationCancellationError) {
      return { kind: "fail" }
    }
    return this.failureDecision(claimed, error)
  }

  private async failureDecision(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const run = await this.context.projectionRunsStorage.getById({
      projectId: this.context.projectId,
      id: claimed.job.id,
    })
    if (run?.status === "running") return retryWithBackoff(claimed)
    if (run) return { kind: "fail" }
    return isPermanentProjectionFailure(error) ? { kind: "fail" } : retryWithBackoff(claimed)
  }
}

function retryWithBackoff(
  claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>
): QueueWorkerFailureDecision {
  return {
    kind: "retry",
    availableAt: projectionRetryAvailableAt({
      jobId: claimed.job.id,
      attempt: claimed.job.attempt,
    }),
  }
}

function buildProjectionContext(
  sixb: ProjectionWorkerSixb,
  projectionRunsStorage: ProjectionRunStorage
): ProjectionWorkerContext {
  const context: ProjectionWorkerContext = {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
    storage: sixb.storage,
    lakeStorage: sixb.lakeStorage,
    blobStorage: sixb.blobStorage,
    queues: sixb.queues,
    projectionRunsStorage,
    getDatasetById: (datasetId) => sixb.getDatasetById(datasetId),
    getProjectionById: (projectionId) => sixb.getProjectionById(projectionId),
  }
  shareOntologyMutationRuntime(sixb, context)
  shareProjectionRegistry(sixb, context)
  return context
}
