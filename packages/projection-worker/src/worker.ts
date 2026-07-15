import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, ProjectionRunRequestedQueueJob } from "@sixb/core/queues"
import type { ProjectionRunStorage } from "@sixb/core/storage"
import { runProjectionJob } from "./run-projection-job"
import type { ProjectionWorkerContext, ProjectionWorkerSixb } from "./types"

export class ProjectionWorker extends QueueWorker<ProjectionRunRequestedQueueJob> {
  private readonly context: ProjectionWorkerContext

  constructor(sixb: ProjectionWorkerSixb) {
    const projectionCount =
      sixb.getObjectProjections().length +
      sixb.getLinkProjections().length +
      sixb.getTelemetryProjections().length
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
    })

    this.context = buildProjectionContext(sixb, projectionRunsStorage)
  }

  protected async execute(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { job } = claimed
    await runProjectionJob({
      runtime: this.context,
      job: {
        id: `${job.id}:attempt:${job.attempt}`,
        projectionId: job.payload.projectionId,
        projectionKind: job.payload.projectionKind,
        datasetId: job.payload.datasetId,
        versionId: job.payload.versionId,
        queueJobId: job.id,
      },
      signal,
    })
  }
}

function buildProjectionContext(
  sixb: ProjectionWorkerSixb,
  projectionRunsStorage: ProjectionRunStorage
): ProjectionWorkerContext {
  return {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
    storage: sixb.storage,
    lakeStorage: sixb.lakeStorage,
    blobStorage: sixb.blobStorage,
    queues: sixb.queues,
    projectionRunsStorage,
    getDatasetById(datasetId) {
      return sixb.getDatasetById(datasetId)
    },
    getProjectionById(projectionId) {
      return sixb.getProjectionById(projectionId)
    },
  }
}
