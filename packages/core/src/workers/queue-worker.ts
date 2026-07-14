import type { ClaimedQueueJob, Queue, QueueJob, QueueJobError } from "../queues"
import { WorkerAbortError } from "./errors"
import {
  createQueueDelivery,
  type QueueDelivery,
  type QueueSettlementResult,
} from "./queue-delivery"
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
const MAX_CONSECUTIVE_CLAIM_FAILURES = 5

export abstract class QueueWorker<TJob extends QueueJob> extends Worker {
  protected readonly config: Required<QueueWorkerConfig<TJob>>
  private consecutiveClaimFailures = 0

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

  protected abstract execute(
    claimed: ClaimedQueueJob<TJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<TJob>
  ): Promise<void>

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
      this.consecutiveClaimFailures = 0
      if (claimed.length === 0) {
        await sleep(idlePollMs, signal).catch(() => {})
      }
      return claimed
    } catch (error) {
      if (signal.aborted) return []
      this.consecutiveClaimFailures += 1
      if (this.consecutiveClaimFailures >= MAX_CONSECUTIVE_CLAIM_FAILURES) {
        this.consecutiveClaimFailures = 0
        throw new Error(
          `[SixbQueueWorker] Queue claim failed ${MAX_CONSECUTIVE_CLAIM_FAILURES} consecutive times.`,
          { cause: error }
        )
      }
      await sleep(idlePollMs, signal).catch(() => {})
      return []
    }
  }

  private async handle(claimed: ClaimedQueueJob<TJob>, signal: AbortSignal): Promise<void> {
    const delivery = createQueueDelivery({
      queue: this.config.queue,
      claimed,
      leaseMs: this.config.leaseMs,
      signal,
      onLeaseLost: () => {
        console.error(
          `[SixbQueueWorker] Lost lease for queue job '${claimed.job.id}'; leaving it for redelivery.`
        )
      },
      onRenewalError: (error) => {
        console.error(
          `[SixbQueueWorker] Could not renew lease for queue job '${claimed.job.id}'; retrying.`,
          error
        )
      },
    })

    try {
      let outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown }
      try {
        await this.execute(claimed, delivery.signal, delivery)
        outcome = { ok: true }
      } catch (error) {
        outcome = { ok: false, error }
      }

      if (delivery.state === "lost") return

      if (outcome.ok) {
        await settleOrLog(delivery, "complete", () => delivery.complete())
        return
      }

      const error = outcome.error
      if (signal.aborted || isAbortError(error)) {
        try {
          const decision = await this.onAbortError(claimed, error)
          await this.applyFailureDecision(delivery, decision, error)
        } catch {
          // Shutdown is already in progress. The unacknowledged job becomes visible after its lease.
        }
        return
      }

      try {
        const decision = await this.onExecutionError(claimed, error)
        await this.applyFailureDecision(delivery, decision, error)
      } catch (settlementError) {
        logQueueOperationError("apply failure decision to", claimed, settlementError)
      }
    } finally {
      await delivery.close()
    }
  }

  private async applyFailureDecision(
    delivery: QueueDelivery<TJob>,
    decision: QueueWorkerFailureDecision,
    error: unknown
  ): Promise<void> {
    if (decision.kind === "retry") {
      await delivery.retry({
        availableAt: decision.availableAt,
        error: toQueueJobError(error),
      })
      return
    }

    await delivery.fail(toQueueJobError(error))
  }
}

async function settleOrLog<TJob extends QueueJob>(
  delivery: QueueDelivery<TJob>,
  operation: string,
  settle: () => Promise<QueueSettlementResult>
): Promise<void> {
  try {
    // A "lost" result needs no extra logging here: loss is already reported via onLeaseLost.
    await settle()
  } catch (error) {
    logQueueOperationError(operation, delivery.claimed, error)
  }
}

function logQueueOperationError(operation: string, claimed: ClaimedQueueJob, error: unknown): void {
  console.error(
    `[SixbQueueWorker] Could not ${operation} queue job '${claimed.job.id}'; it may be redelivered.`,
    error
  )
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
