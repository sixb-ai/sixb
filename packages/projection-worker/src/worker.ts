import type { LakeStorage, Queues, SixbDefinitions, Storage } from "@sixb/core"
import { MaterializationCancellationError } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import { shareProjectionRegistry } from "@sixb/core/internal/projections"
import { registerOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import { shareDatasetVersionMarkings } from "@sixb/core/internal/security"
import type {
  HeldRunClaim,
  QueueWorkerFailureDecision,
  RunDelivery,
} from "@sixb/core/internal/workers"
import { RunOwnedElsewhereError, RunWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, ProjectionRunRequestedQueueJob } from "@sixb/core/queues"
import {
  PROJECTION_RUN_FAILURE_CODES,
  type ProjectionRunFailureCode,
  ProjectionRunHeldError,
  type ProjectionRunRecord,
  type ProjectionRunStorage,
} from "@sixb/core/storage"
import { projectionRetryAvailableAt } from "./retry-backoff"
import { isPermanentProjectionFailure, runProjectionJob } from "./run-projection-job"
import type { ProjectionWorkerContext } from "./types"
import { VectorIndexingWorker } from "./vector-indexing-worker"

export interface ProjectionWorkerOptions {
  /** Maximum projection run jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
  /** Independent embedding concurrency. Defaults to 4. */
  readonly vectorConcurrency?: number
}

/**
 * Embedding calls wait on the network, so they overlap cheaply. The provider's rate limit is the
 * ceiling, and a rejected call is a terminal failure, so the default stays well below it.
 */
const DEFAULT_VECTOR_CONCURRENCY = 4

export class ProjectionWorker extends RunWorker<
  ProjectionRunRequestedQueueJob,
  typeof PROJECTION_RUN_FAILURE_CODES,
  ProjectionRunRecord
> {
  private readonly vectorWorker?: VectorIndexingWorker
  private readonly host: ProjectionWorkerHost
  private readonly projectionRunsStorage: ProjectionRunStorage

  constructor(host: ProjectionWorkerHost, options: ProjectionWorkerOptions = {}) {
    const projectionCount = host.definitions.projections.list().length
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
      failureCodes: PROJECTION_RUN_FAILURE_CODES,
      workerId: `projection-worker-${host.id}`,
      claimLimit: options.concurrency,
      runs: projectionRunsStorage,
      maxAttempts: Number.POSITIVE_INFINITY,
    })
    this.host = host
    this.projectionRunsStorage = projectionRunsStorage
    if (
      host.definitions.ontology
        .listObjectTypes()
        .some((type) => Object.keys(type.search?.vectors ?? {}).length > 0)
    )
      this.vectorWorker = new VectorIndexingWorker(
        host,
        options.vectorConcurrency ?? DEFAULT_VECTOR_CONCURRENCY
      )
  }

  override async start(): Promise<void> {
    await Promise.all([super.start(), this.vectorWorker?.start()])
  }
  override async stop(): Promise<void> {
    await Promise.all([super.stop(), this.vectorWorker?.stop()])
  }
  override async wait(): Promise<void> {
    await Promise.all([super.wait(), this.vectorWorker?.wait()])
  }

  /**
   * A projection takes its run inside the job, which also asserts the run's immutable identity and
   * answers a replay from its outcome. Its token is the one the materializer fences commits with.
   */
  protected async claimRun(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>
  ): Promise<RunDelivery<ProjectionRunRecord>> {
    const run = await this.findRun(claimed)
    if (!run) {
      throw new Error(
        `[SixbProjectionWorker] Projection run '${claimed.job.payload.runId}' was not found.`
      )
    }

    return { outcome: "woken", run }
  }

  protected async executeRun(
    claim: HeldRunClaim<ProjectionRunRecord>,
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { run } = claim

    const durableExecution = await this.host.storage.executions.getById({
      projectId: this.host.id,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw new Error(
        `[SixbProjectionWorker] Projection run '${run.id}' references missing execution '${run.executionId}'.`
      )
    }
    const execution = bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: { kind: "projection", id: run.identity.projectionId, runId: run.id },
    })
    const context = buildProjectionContext(this.host, this.projectionRunsStorage, execution)

    try {
      await runProjectionJob({
        runtime: context,
        job: { id: run.id, ...run.identity },
        signal,
        execution: claim.execution,
        onRunFailed: (error, run, failure) => {
          reportRunFailure(this.host, error, {
            projectId: this.host.id,
            attempt: run.attempt,
            runKind: "projection",
            run: {
              runId: run.id,
              projectionId: run.identity.projectionId,
              projectionKind: run.identity.projectionKind,
            },
            failure,
          })
        },
      })
    } catch (error) {
      if (error instanceof ProjectionRunHeldError) {
        throw new RunOwnedElsewhereError(error.runId, error.ownedUntil)
      }
      throw error
    }
  }

  /** A deterministic failure is a verdict only on a run the job never took: it has no record. */
  protected override async onExecutionError(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<ProjectionRunFailureCode>> {
    if (isPermanentProjectionFailure(error)) {
      const run = await this.findRun(claimed)
      if (!run || run.status === "queued") return { kind: "fail" }
    }

    return super.onExecutionError(claimed, error)
  }

  protected override async onAbortError(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<ProjectionRunFailureCode>> {
    if (error instanceof MaterializationCancellationError) {
      const run = await this.findRun(claimed)

      // A running run's error is its last attempt's failure, not an outcome to report.
      return run?.error && run.status !== "running"
        ? { kind: "fail", failure: run.error }
        : { kind: "fail" }
    }

    return super.onAbortError(claimed, error)
  }

  protected override nextRetryAt(claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>): string {
    return projectionRetryAvailableAt({
      jobId: claimed.job.payload.runId,
      attempt: claimed.job.attempt,
    })
  }

  private findRun(
    claimed: ClaimedQueueJob<ProjectionRunRequestedQueueJob>
  ): Promise<ProjectionRunRecord | null> {
    return this.projectionRunsStorage.getById({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
    })
  }
}

function buildProjectionContext(
  host: ProjectionWorkerHost,
  projectionRunsStorage: ProjectionRunStorage,
  execution: ReturnType<typeof bindDurablePrimitiveExecution>
): ProjectionWorkerContext {
  const context: ProjectionWorkerContext = {
    projectId: host.id,
    ontology: host.definitions.ontology,
    lakeStorage: host.lakeStorage,
    projectionRunsStorage,
    ...(host.storage.auth ? { users: host.storage.auth.users } : {}),
    datasets: host.definitions.datasets,
    projections: host.definitions.projections,
  }
  registerOntologyMutationRuntime(context, execution.ontologyMutations)
  shareProjectionRegistry(host, context)
  shareDatasetVersionMarkings(host, context)
  return context
}

export interface ProjectionWorkerHost extends PrimitiveExecutionHost {
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly definitions: Pick<SixbDefinitions, "ontology" | "datasets" | "projections">
}
