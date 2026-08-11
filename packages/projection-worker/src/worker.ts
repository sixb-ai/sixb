import type {
  DatasetsRuntime,
  LakeStorage,
  OntologyRegistry,
  ProjectionsRuntime,
  Queues,
  Storage,
} from "@sixb/core"
import { MaterializationCancellationError } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import {
  bindPrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import { shareProjectionRegistry } from "@sixb/core/internal/projections"
import { registerOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, ProjectionRunRequestedQueueJob } from "@sixb/core/queues"
import type { ProjectionRunStorage } from "@sixb/core/storage"
import { projectionRetryAvailableAt } from "./retry-backoff"
import { isPermanentProjectionFailure, runProjectionJob } from "./run-projection-job"
import type { ProjectionWorkerContext } from "./types"

export class ProjectionWorker extends QueueWorker<ProjectionRunRequestedQueueJob> {
  private readonly host: ProjectionWorkerHost
  private readonly projectionRunsStorage: ProjectionRunStorage

  constructor(host: ProjectionWorkerHost) {
    const projectionCount = host.projections.list().length
    if (projectionCount === 0) {
      throw new Error("[SixbProjectionWorker] No projection definitions are registered.")
    }

    const projectionRunsStorage = host.storage.projectionRuns
    if (!projectionRunsStorage) {
      throw new Error("[SixbProjectionWorker] Projection workers require storage.projectionRuns.")
    }

    super({
      projectId: host.id,
      queue: host.queues.projections,
      workerId: `projection-worker-${host.id}`,
    })
    this.host = host
    this.projectionRunsStorage = projectionRunsStorage
  }

  protected async execute(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { job } = claimed
    const execution = bindPrimitiveExecution(this.host, {
      primitive: {
        kind: "projection",
        id: job.payload.projectionId,
        runId: job.id,
      },
      source: { type: "queue", queue: "projections", jobId: job.id },
    })
    const context = buildProjectionContext(this.host, this.projectionRunsStorage, execution)
    await runProjectionJob({
      runtime: context,
      job: { id: job.id, ...job.payload },
      signal,
      onRunFailed: (error, run) => {
        reportRunFailure(this.host, error, {
          projectId: this.host.id,
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
    const run = await this.projectionRunsStorage.getById({
      projectId: this.host.id,
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
  host: ProjectionWorkerHost,
  projectionRunsStorage: ProjectionRunStorage,
  execution: ReturnType<typeof bindPrimitiveExecution>
): ProjectionWorkerContext {
  const context: ProjectionWorkerContext = {
    projectId: host.id,
    ontology: host.ontology,
    lakeStorage: host.lakeStorage,
    projectionRunsStorage,
    datasets: host.datasets,
    projections: host.projections,
  }
  registerOntologyMutationRuntime(context, execution.ontologyMutations)
  shareProjectionRegistry(host, context)
  return context
}

export interface ProjectionWorkerHost extends PrimitiveExecutionHost {
  readonly ontology: OntologyRegistry
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly datasets: Pick<DatasetsRuntime, "getById">
  readonly projections: Pick<ProjectionsRuntime, "list" | "getById">
}
