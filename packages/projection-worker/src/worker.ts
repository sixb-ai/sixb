import type {
  ClaimedQueueJob,
  ProjectionRunRequestedQueueJob,
  ProjectionRunStorage,
} from "@pario/core"
import { QueueWorker } from "@pario/core"
import { runProjectionJob } from "./run-projection-job"
import type { ProjectionWorkerContext, ProjectionWorkerPario } from "./types"

export class ProjectionWorker extends QueueWorker<ProjectionRunRequestedQueueJob> {
  private readonly context: ProjectionWorkerContext

  constructor(pario: ProjectionWorkerPario) {
    const projectionCount = pario.getObjectProjections().length + pario.getLinkProjections().length
    if (projectionCount === 0) {
      throw new Error("[ParioProjectionWorker] No projection definitions are registered.")
    }

    const projectionRunsStorage = pario.storage.projectionRuns
    if (!projectionRunsStorage) {
      throw new Error("[ParioProjectionWorker] Projection workers require storage.projectionRuns.")
    }

    super({
      projectId: pario.projectId,
      queue: pario.queues.projections,
      workerId: `projection-worker-${pario.id}`,
    })

    this.context = buildProjectionContext(pario, projectionRunsStorage)
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
  pario: ProjectionWorkerPario,
  projectionRunsStorage: ProjectionRunStorage
): ProjectionWorkerContext {
  return {
    projectId: pario.projectId,
    ontology: pario.ontology,
    actionRegistry: pario.actionRegistry,
    events: pario.events,
    storage: pario.storage,
    lakeStorage: pario.lakeStorage,
    blobStorage: pario.blobStorage,
    queues: pario.queues,
    projectionRunsStorage,
    getDatasetById(datasetId) {
      return pario.getDatasetById(datasetId)
    },
    getProjectionById(projectionId) {
      return pario.getProjectionById(projectionId)
    },
  }
}
