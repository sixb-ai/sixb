import type {
  ClaimedQueueJob,
  ProjectionRunRequestedQueueJob,
  ProjectionRunStorage,
} from "@sixb/core"
import { QueueWorker } from "@sixb/core"
import { runProjectionJob } from "./run-projection-job"
import type { ProjectionWorkerContext, ProjectionWorkerSixb } from "./types"

export class ProjectionWorker extends QueueWorker<ProjectionRunRequestedQueueJob> {
  private readonly context: ProjectionWorkerContext | null

  constructor(sixb: ProjectionWorkerSixb) {
    const projectionCount = sixb.getObjectProjections().length + sixb.getLinkProjections().length
    const idle = projectionCount === 0

    super({
      projectId: sixb.projectId,
      queue: sixb.queues.projections,
      workerId: `projection-worker-${sixb.id}`,
      idle,
    })

    if (idle) {
      console.log(
        "[SixbProjectionWorker] No projection definitions are registered; worker will idle."
      )
      this.context = null
      return
    }

    const projectionRunsStorage = sixb.storage.projectionRuns
    if (!projectionRunsStorage) {
      throw new Error("[SixbProjectionWorker] Projection workers require storage.projectionRuns.")
    }

    this.context = buildProjectionContext(sixb, projectionRunsStorage)
  }

  protected async execute(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const context = this.requireContext()
    const { job } = claimed
    await runProjectionJob({
      runtime: context,
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

  private requireContext(): ProjectionWorkerContext {
    if (!this.context) {
      throw new Error("[SixbProjectionWorker] No projection definitions are registered.")
    }
    return this.context
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
