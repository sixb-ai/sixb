import type { ClaimedQueueJob, Queue, QueueJob, QueueJobError } from "../queues"
import { workerAbortError } from "./errors"

export type QueueDeliveryState = "active" | "lost" | "settled"

/**
 * Outcome of a settlement call. `"lost"` means the queue job was **not** acknowledged because
 * ownership was already gone — the job may be redelivered. Settlement never throws for a lost
 * lease; exceptions are reserved for queue calls that themselves fail (outcome then unknown).
 */
export type QueueSettlementResult = "settled" | "lost"

export interface QueueDelivery<TJob extends QueueJob> {
  readonly claimed: ClaimedQueueJob<TJob>
  readonly signal: AbortSignal
  readonly state: QueueDeliveryState
  /** Expiration from the latest queue-confirmed claim or renewal. */
  readonly leaseExpiresAt: string

  /** Observe successful queue renewals. The listener is not called for failed renewals. */
  onLeaseRenewed(listener: (claimed: ClaimedQueueJob<TJob>) => void): () => void
  complete(): Promise<QueueSettlementResult>
  retry(input?: {
    readonly availableAt?: string
    readonly error?: QueueJobError
  }): Promise<QueueSettlementResult>
  fail(error: QueueJobError): Promise<QueueSettlementResult>
  close(): Promise<void>
}

export interface CreateQueueDeliveryOptions<TJob extends QueueJob> {
  readonly queue: Queue<TJob>
  readonly claimed: ClaimedQueueJob<TJob>
  readonly leaseMs: number
  readonly signal: AbortSignal
  readonly onLeaseLost?: () => void
  readonly onRenewalError?: (error: unknown) => void
}

const MIN_RENEWAL_INTERVAL_MS = 1

type RenewalAttempt<TJob extends QueueJob> =
  | { readonly kind: "renewed"; readonly claimed: ClaimedQueueJob<TJob> | null }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "expired" }

/** Owns lease renewal, loss detection, and settlement for one claimed queue job. */
export function createQueueDelivery<TJob extends QueueJob>(
  options: CreateQueueDeliveryOptions<TJob>
): QueueDelivery<TJob> {
  return new ManagedQueueDelivery(options)
}

class ManagedQueueDelivery<TJob extends QueueJob> implements QueueDelivery<TJob> {
  readonly claimed: ClaimedQueueJob<TJob>
  readonly signal: AbortSignal

  private readonly queue: Queue<TJob>
  private readonly leaseMs: number
  private readonly renewLease: Queue<TJob>["renewLease"]
  private readonly onLeaseLost: (() => void) | undefined
  private readonly onRenewalError: ((error: unknown) => void) | undefined
  private readonly lossController = new AbortController()
  private readonly stopController = new AbortController()
  private readonly renewalIntervalMs: number
  private readonly renewalLoop: Promise<void>
  private readonly leaseRenewedListeners = new Set<(claimed: ClaimedQueueJob<TJob>) => void>()
  private currentState: QueueDeliveryState = "active"
  private currentLeaseExpiresAt: string
  private leaseExpiresAtTimestamp: number
  private renewalErrorReported = false
  private closing: Promise<void> | null = null
  private settling = false

  constructor(options: CreateQueueDeliveryOptions<TJob>) {
    this.queue = options.queue
    this.claimed = options.claimed
    this.leaseMs = options.leaseMs
    this.renewLease = options.queue.renewLease?.bind(options.queue)
    this.onLeaseLost = options.onLeaseLost
    this.onRenewalError = options.onRenewalError
    this.currentLeaseExpiresAt = options.claimed.leaseExpiresAt
    this.leaseExpiresAtTimestamp = parseLeaseExpiration(options.claimed.leaseExpiresAt)
    this.renewalIntervalMs = Math.max(MIN_RENEWAL_INTERVAL_MS, Math.floor(options.leaseMs / 3))
    this.signal = AbortSignal.any([options.signal, this.lossController.signal])
    this.renewalLoop = this.runRenewalLoop()
  }

  get state(): QueueDeliveryState {
    return this.currentState
  }

  get leaseExpiresAt(): string {
    return this.currentLeaseExpiresAt
  }

  onLeaseRenewed(listener: (claimed: ClaimedQueueJob<TJob>) => void): () => void {
    this.leaseRenewedListeners.add(listener)
    return () => this.leaseRenewedListeners.delete(listener)
  }

  complete(): Promise<QueueSettlementResult> {
    return this.settle(() =>
      this.queue.complete({
        projectId: this.claimed.job.projectId,
        jobId: this.claimed.job.id,
        leaseId: this.claimed.leaseId,
      })
    )
  }

  retry(
    input: { readonly availableAt?: string; readonly error?: QueueJobError } = {}
  ): Promise<QueueSettlementResult> {
    return this.settle(() =>
      this.queue.retry({
        projectId: this.claimed.job.projectId,
        jobId: this.claimed.job.id,
        leaseId: this.claimed.leaseId,
        availableAt: input.availableAt,
        error: input.error,
      })
    )
  }

  fail(error: QueueJobError): Promise<QueueSettlementResult> {
    return this.settle(() =>
      this.queue.fail({
        projectId: this.claimed.job.projectId,
        jobId: this.claimed.job.id,
        leaseId: this.claimed.leaseId,
        error,
      })
    )
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.stopRenewal()
    return this.closing
  }

  private async settle(operation: () => Promise<void>): Promise<QueueSettlementResult> {
    if (this.currentState !== "active") {
      return this.currentState === "settled" ? "settled" : "lost"
    }
    if (this.settling) {
      throw new Error(`[SixbQueueWorker] Queue job '${this.claimed.job.id}' is already settling.`)
    }

    this.settling = true
    try {
      await this.stopRenewal()
      if (!(await this.confirmSettlementLease())) return "lost"
      await operation()
      this.currentState = "settled"
      return "settled"
    } finally {
      this.settling = false
    }
  }

  private async confirmSettlementLease(): Promise<boolean> {
    if (this.currentState !== "active") return false
    if (Date.now() >= this.leaseExpiresAtTimestamp) {
      this.markLost()
      return false
    }
    if (!this.renewLease) return true

    const attempt = await this.attemptRenewal()
    if (attempt.kind === "renewed") {
      if (!attempt.claimed) {
        this.markLost()
        return false
      }
      this.recordRenewal(attempt.claimed)
      return true
    }
    if (attempt.kind === "failed") {
      this.reportRenewalError(attempt.error)
    }
    if (attempt.kind === "expired" || Date.now() >= this.leaseExpiresAtTimestamp) {
      this.markLost()
      return false
    }
    return true
  }

  private async runRenewalLoop(): Promise<void> {
    while (this.currentState === "active" && !this.stopController.signal.aborted) {
      const remainingMs = this.leaseExpiresAtTimestamp - Date.now()
      if (remainingMs <= 0) {
        this.markLost()
        return
      }

      const delayMs = this.renewLease ? Math.min(this.renewalIntervalMs, remainingMs) : remainingMs
      await sleep(delayMs, this.stopController.signal).catch(() => {})
      if (this.stopController.signal.aborted || this.currentState !== "active") return
      if (Date.now() >= this.leaseExpiresAtTimestamp) {
        this.markLost()
        return
      }
      if (!this.renewLease) continue

      const attempt = await this.attemptRenewal()
      if (attempt.kind === "expired") {
        this.markLost()
        return
      }
      if (attempt.kind === "failed") {
        this.reportRenewalError(attempt.error)
        continue
      }
      if (!attempt.claimed) {
        this.markLost()
        return
      }
      this.recordRenewal(attempt.claimed)
    }
  }

  private attemptRenewal(): Promise<RenewalAttempt<TJob>> {
    if (!this.renewLease || Date.now() >= this.leaseExpiresAtTimestamp) {
      return Promise.resolve({ kind: "expired" })
    }

    const remainingMs = Math.max(1, this.leaseExpiresAtTimestamp - Date.now())
    return new Promise((resolve) => {
      let finished = false
      const finish = (attempt: RenewalAttempt<TJob>): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve(attempt)
      }
      const timer = setTimeout(() => finish({ kind: "expired" }), remainingMs)

      this.renewLease?.({
        projectId: this.claimed.job.projectId,
        jobId: this.claimed.job.id,
        leaseId: this.claimed.leaseId,
        leaseMs: this.leaseMs,
      }).then(
        (claimed) => finish({ kind: "renewed", claimed }),
        (error) => finish({ kind: "failed", error })
      )
    })
  }

  private recordRenewal(claimed: ClaimedQueueJob<TJob>): void {
    this.currentLeaseExpiresAt = claimed.leaseExpiresAt
    this.leaseExpiresAtTimestamp = parseLeaseExpiration(claimed.leaseExpiresAt)
    this.renewalErrorReported = false
    for (const listener of this.leaseRenewedListeners) {
      try {
        listener(claimed)
      } catch (error) {
        this.onRenewalError?.(error)
      }
    }
  }

  private reportRenewalError(error: unknown): void {
    if (this.renewalErrorReported) return
    this.renewalErrorReported = true
    this.onRenewalError?.(error)
  }

  private markLost(): void {
    if (this.currentState !== "active") return
    this.currentState = "lost"
    this.lossController.abort(
      workerAbortError(`[SixbQueueWorker] Queue job '${this.claimed.job.id}' lost its lease.`, {
        code: "queue.lease_lost",
      })
    )
    this.onLeaseLost?.()
  }

  private async stopRenewal(): Promise<void> {
    this.stopController.abort()
    await this.renewalLoop.catch(() => {})
  }
}

function parseLeaseExpiration(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new Error(`[SixbQueueWorker] Invalid queue lease expiration '${value}'.`)
  }
  return timestamp
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}
