import { captureSixbFailure } from "../errors/internal"
import type { SixbErrorCode, SixbFailure } from "../errors/types"
import type { ClaimedQueueJob, Queue, QueueJob } from "../queues"
import { WorkerAbortError } from "./errors"
import {
  createQueueDelivery,
  type QueueDelivery,
  type QueueSettlementResult,
} from "./queue-delivery"
import { Worker } from "./worker"

type QueueWorkerFailureCodes = readonly [
  "internal.unexpected",
  "runtime.cancelled",
  ...SixbErrorCode[],
]

export interface QueueWorkerConfig<
  TJob extends QueueJob,
  TFailureCodes extends QueueWorkerFailureCodes,
> {
  readonly projectId: string
  readonly queue: Queue<TJob, TFailureCodes[number]>
  /** Runtime counterpart of this lane's precise terminal-failure union. */
  readonly failureCodes: TFailureCodes
  readonly workerId: string
  readonly leaseMs?: number
  readonly claimLimit?: number
  readonly idlePollMs?: number
}

/**
 * Queue settlement selected after execution stops.
 *
 * A worker must name its allowed failure-code union before it can supply an already-persisted
 * failure. Workers that only choose retry vs fail need no generic annotation.
 */
export type QueueWorkerFailureDecision<TFailureCode extends SixbErrorCode = never> =
  | {
      readonly kind: "retry"
      readonly availableAt?: string
    }
  | {
      readonly kind: "fail"
      /** Exact durable run failure, when execution already persisted one. */
      readonly failure?: SixbFailure<TFailureCode>
    }

const DEFAULT_LEASE_MS = 15 * 60_000
const DEFAULT_CLAIM_LIMIT = 1
const DEFAULT_IDLE_POLL_MS = 1_000
const MAX_CONSECUTIVE_CLAIM_FAILURES = 5

export abstract class QueueWorker<
  TJob extends QueueJob,
  TFailureCodes extends QueueWorkerFailureCodes,
> extends Worker {
  protected readonly config: Required<QueueWorkerConfig<TJob, TFailureCodes>>
  private consecutiveClaimFailures = 0

  constructor(config: QueueWorkerConfig<TJob, TFailureCodes>) {
    super()
    this.config = {
      projectId: config.projectId,
      queue: config.queue,
      failureCodes: config.failureCodes,
      workerId: config.workerId,
      leaseMs: config.leaseMs ?? DEFAULT_LEASE_MS,
      claimLimit: normalizeClaimLimit(config.claimLimit),
      idlePollMs: config.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
    }
  }

  /** Maximum jobs this worker process claims and executes at once. */
  get concurrency(): number {
    return this.config.claimLimit
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
    delivery: QueueDelivery<TJob, TFailureCodes[number]>
  ): Promise<void>

  protected onExecutionError(
    _claimed: ClaimedQueueJob<TJob>,
    _error: unknown
  ):
    | Promise<QueueWorkerFailureDecision<TFailureCodes[number]>>
    | QueueWorkerFailureDecision<TFailureCodes[number]> {
    return { kind: "fail" }
  }

  protected onAbortError(
    _claimed: ClaimedQueueJob<TJob>,
    _error: unknown
  ):
    | Promise<QueueWorkerFailureDecision<TFailureCodes[number]>>
    | QueueWorkerFailureDecision<TFailureCodes[number]> {
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
          await this.applyFailureDecision(delivery, decision, error, "runtime.cancelled")
        } catch {
          // Shutdown is already in progress. The unacknowledged job becomes visible after its lease.
        }
        return
      }

      try {
        const decision = await this.onExecutionError(claimed, error)
        await this.applyFailureDecision(delivery, decision, error, "internal.unexpected")
      } catch (settlementError) {
        logQueueOperationError("apply failure decision to", claimed, settlementError)
      }
    } finally {
      await delivery.close()
    }
  }

  private async applyFailureDecision(
    delivery: QueueDelivery<TJob, TFailureCodes[number]>,
    decision: QueueWorkerFailureDecision<TFailureCodes[number]>,
    error: unknown,
    defaultCode: "internal.unexpected" | "runtime.cancelled"
  ): Promise<void> {
    if (decision.kind === "retry") {
      await delivery.retry({ availableAt: decision.availableAt })
      return
    }

    const failure =
      decision.failure ??
      captureSixbFailure(error, {
        allowedCodes: this.config.failureCodes,
        defaultCode,
      })
    await delivery.fail(failure)
  }
}

function normalizeClaimLimit(value: number | undefined): number {
  const claimLimit = value ?? DEFAULT_CLAIM_LIMIT
  if (!Number.isSafeInteger(claimLimit) || claimLimit < 1) {
    throw new Error("[SixbQueueWorker] Worker concurrency must be a positive safe integer.")
  }
  return claimLimit
}

async function settleOrLog<TJob extends QueueJob, TFailureCode extends SixbErrorCode>(
  delivery: QueueDelivery<TJob, TFailureCode>,
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
