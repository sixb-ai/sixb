import {
  getVectorIndexingRuntime,
  VectorIndexingDeferred,
  type VectorIndexingRuntime,
} from "@sixb/core/internal/runtime"
import { QueueWorker, type QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, VectorIndexingQueueJob } from "@sixb/core/queues"
import type { ProjectionWorkerHost } from "./worker"

const FAILURE_CODES = ["internal.unexpected", "runtime.cancelled"] as const

/** Separate lane: model latency and budgets never consume a projection slot. */
export class VectorIndexingWorker extends QueueWorker<
  VectorIndexingQueueJob,
  typeof FAILURE_CODES
> {
  private readonly runtime: VectorIndexingRuntime
  constructor(host: ProjectionWorkerHost, concurrency: number) {
    super({
      projectId: host.id,
      queue: host.queues.vectorIndexing,
      failureCodes: FAILURE_CODES,
      workerId: `vector-indexing-${host.id}`,
      claimLimit: concurrency,
    })
    if (!host.storage.ontology.vectorIndexing)
      throw new Error(
        "[SixbProjectionWorker] Vector profiles require durable vector indexing storage."
      )
    this.runtime = getVectorIndexingRuntime(host)
  }

  protected execute(
    claimed: ClaimedQueueJob<VectorIndexingQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    return this.runtime.process(claimed.job.payload.indexingId, claimed.job.attempt, signal)
  }

  protected override onExecutionError(
    claimed: ClaimedQueueJob<VectorIndexingQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    if (!(error instanceof VectorIndexingDeferred)) {
      console.warn(
        `[SixbProjectionWorker] Could not finish vector indexing '${claimed.job.payload.indexingId}'; retrying storage work.`,
        error
      )
    }
    return {
      kind: "retry",
      availableAt:
        error instanceof VectorIndexingDeferred
          ? error.availableAt
          : new Date(Date.now() + 5000).toISOString(),
    }
  }
  protected override onAbortError(): QueueWorkerFailureDecision {
    return { kind: "retry" }
  }
}
