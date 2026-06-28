import type { ClaimedQueueJob, Queue, QueueJob, QueueJobError } from "../queues"
import { WorkerAbortError } from "./errors"
import { Worker } from "./worker"

export interface QueueWorkerConfig<TJob extends QueueJob> {
  readonly projectId: string
  readonly queue: Queue<TJob>
  readonly workerId: string
  readonly leaseMs?: number
  readonly claimLimit?: number
  readonly idlePollMs?: number
}

export interface QueueWorkerFailureDecision {
  readonly kind: "retry" | "fail"
  readonly availableAt?: string
}

const DEFAULT_LEASE_MS = 15 * 60_000
const DEFAULT_CLAIM_LIMIT = 1
const DEFAULT_IDLE_POLL_MS = 1_000

export abstract class QueueWorker<TJob extends QueueJob> extends Worker {
  protected readonly config: Required<QueueWorkerConfig<TJob>>

  constructor(config: QueueWorkerConfig<TJob>) {
    super()
    this.config = {
      projectId: config.projectId,
      queue: config.queue,
      workerId: config.workerId,
      leaseMs: config.leaseMs ?? DEFAULT_LEASE_MS,
      claimLimit: config.claimLimit ?? DEFAULT_CLAIM_LIMIT,
      idlePollMs: config.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
    }
  }

  protected async run(signal: AbortSignal): Promise<void> {
    const inFlight = new Set<Promise<void>>()
    let runError: unknown = null

    try {
      while (!signal.aborted && !runError) {
        while (!signal.aborted && !runError && inFlight.size >= this.config.claimLimit) {
          await Promise.race(inFlight)
        }
        if (runError || signal.aborted) {
          continue
        }

        const capacity = this.config.claimLimit - inFlight.size
        const claimed = await this.claimOrIdle(signal, capacity)
        for (const claimedJob of claimed) {
          const promise = this.handle(claimedJob, signal)
            .catch((error) => {
              runError ??= error
            })
            .finally(() => {
              inFlight.delete(promise)
            })
          inFlight.add(promise)
        }
      }
    } finally {
      await Promise.allSettled(inFlight)
    }

    if (runError) {
      throw runError
    }
  }

  protected abstract execute(claimed: ClaimedQueueJob<TJob>, signal: AbortSignal): Promise<void>

  protected onExecutionError(
    _claimed: ClaimedQueueJob<TJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> | QueueWorkerFailureDecision {
    return { kind: "fail" }
  }

  protected onAbortError(
    _claimed: ClaimedQueueJob<TJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> | QueueWorkerFailureDecision {
    // Shutdown should normally release work for another process. Workers with non-idempotent
    // partial commits can override this and fail the job instead.
    return { kind: "retry" }
  }

  private async claimOrIdle(
    signal: AbortSignal,
    limit: number
  ): Promise<readonly ClaimedQueueJob<TJob>[]> {
    const { projectId, queue, workerId, leaseMs, idlePollMs } = this.config

    try {
      const claimed = await queue.claim({
        projectId,
        workerId,
        limit,
        leaseMs,
      })
      if (claimed.length === 0) {
        await sleep(idlePollMs, signal).catch(() => {})
      }
      return claimed
    } catch {
      if (signal.aborted) return []
      await sleep(idlePollMs, signal).catch(() => {})
      return []
    }
  }

  private async handle(claimed: ClaimedQueueJob<TJob>, signal: AbortSignal): Promise<void> {
    const { projectId, queue } = this.config
    const jobId = claimed.job.id
    const leaseId = claimed.leaseId

    try {
      await this.execute(claimed, signal)
      await queue.complete({ projectId, jobId, leaseId })
      return
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        const decision = await this.onAbortError(claimed, error)
        await this.applyFailureDecision({ decision, projectId, jobId, leaseId, error }).catch(
          () => {}
        )
        return
      }

      const decision = await this.onExecutionError(claimed, error)
      await this.applyFailureDecision({ decision, projectId, jobId, leaseId, error })
    }
  }

  private async applyFailureDecision(input: {
    readonly decision: QueueWorkerFailureDecision
    readonly projectId: string
    readonly jobId: string
    readonly leaseId: string
    readonly error: unknown
  }): Promise<void> {
    const { queue } = this.config

    if (input.decision.kind === "retry") {
      await queue.retry({
        projectId: input.projectId,
        jobId: input.jobId,
        leaseId: input.leaseId,
        availableAt: input.decision.availableAt,
        error: toQueueJobError(input.error),
      })
      return
    }

    await queue.fail({
      projectId: input.projectId,
      jobId: input.jobId,
      leaseId: input.leaseId,
      error: toQueueJobError(input.error),
    })
  }
}

function toQueueJobError(error: unknown): QueueJobError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { message: String(error) }
}

/** True for a standard abort (`AbortController`/`AbortSignal.timeout`) error. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new WorkerAbortError("Worker runtime aborted.")
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(new WorkerAbortError("Worker runtime aborted."))
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}
