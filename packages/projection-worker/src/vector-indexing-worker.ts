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
  constructor(
    private readonly host: ProjectionWorkerHost,
    concurrency: number
  ) {
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

  protected override async run(signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const tasks = [super.run(combined), this.dispatch(combined)]
    try {
      await Promise.all(tasks)
    } finally {
      controller.abort()
      await Promise.allSettled(tasks)
    }
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

  private async dispatch(signal: AbortSignal): Promise<void> {
    const indexing = this.host.storage.ontology.vectorIndexing!
    while (!signal.aborted) {
      const now = new Date()
      const work = await indexing.listDue({
        projectId: this.host.id,
        now: now.toISOString(),
        limit: 100,
      })
      signal.throwIfAborted()
      if (work.length) {
        await this.host.queues.vectorIndexing.enqueue({
          projectId: this.host.id,
          jobs: work.map((item) => ({
            id: item.id,
            type: "vector.index.requested",
            payload: { indexingId: item.id },
            availableAt: item.availableAt,
          })),
        })
        await indexing.dispatched({
          projectId: this.host.id,
          ids: work.map((item) => item.id),
          nextDispatchAt: new Date(now.getTime() + 30_000).toISOString(),
        })
      }
      if (work.length < 100) await delay(1000, signal)
    }
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}
