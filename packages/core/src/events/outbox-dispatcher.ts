import { randomUUID } from "node:crypto"
import type { ClaimedOntologyOutboxRow, OntologyOutboxStorage, Storage } from "../storage"
import type { StableEventPublisher } from "./runtime"

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_LEASE_DURATION_MS = 30_000
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000
const DEFAULT_RETRY_JITTER_RATIO = 0.2
const DEFAULT_MAX_ISOLATION_ATTEMPTS = 16
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000
const SHUTDOWN_RESCHEDULE_ERROR = "Outbox dispatcher stopped before publication completed."

export interface OntologyOutboxDeliveryFailure {
  readonly occurredAt: string
  readonly attempts: number
  readonly eventIds: readonly string[]
}

export interface OntologyOutboxDispatcherOptions {
  readonly projectId: string
  readonly storage: Storage
  /** Internal publisher port. It cannot author or mutate persisted ontology facts. */
  readonly events: StableEventPublisher
  readonly batchSize?: number
  readonly leaseDurationMs?: number
  readonly initialRetryDelayMs?: number
  readonly maxRetryDelayMs?: number
  /** Symmetric jitter ratio in the inclusive range 0..1. */
  readonly retryJitterRatio?: number
  /** Maximum broker calls used to isolate poison envelopes in one claimed batch. */
  readonly maxIsolationAttempts?: number
  readonly shutdownTimeoutMs?: number
  readonly now?: () => Date
  readonly random?: () => number
  readonly createLeaseId?: () => string
  readonly onDeliveryFailure?: (error: unknown, failure: OntologyOutboxDeliveryFailure) => void
  readonly onError?: (error: unknown) => void
}

/**
 * One claimed batch whose unsettled rows remain recoverable during shutdown.
 *
 * Rows leave the set immediately before their lease is settled in storage. If storage settlement
 * itself fails, lease expiry remains the durable recovery path.
 */
class ClaimedBatch {
  private readonly unsettled = new Map<string, ClaimedOntologyOutboxRow>()
  private closed = false

  constructor(rows: readonly ClaimedOntologyOutboxRow[]) {
    for (const row of rows) this.unsettled.set(row.envelope.id, row)
  }

  take(rows: readonly ClaimedOntologyOutboxRow[]): readonly ClaimedOntologyOutboxRow[] {
    if (this.closed || rows.some((row) => !this.unsettled.has(row.envelope.id))) return []
    for (const row of rows) this.unsettled.delete(row.envelope.id)
    return rows
  }

  close(): readonly ClaimedOntologyOutboxRow[] {
    this.closed = true
    const rows = [...this.unsettled.values()]
    this.unsettled.clear()
    return rows
  }
}

/** Lease-based, at-least-once publisher for the authoritative ontology outbox. */
export class OntologyOutboxDispatcher {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly events: StableEventPublisher
  private readonly batchSize: number
  private readonly leaseDurationMs: number
  private readonly initialRetryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly retryJitterRatio: number
  private readonly maxIsolationAttempts: number
  private readonly shutdownTimeoutMs: number
  private readonly now: () => Date
  private readonly random: () => number
  private readonly createLeaseId: () => string
  private readonly onDeliveryFailure?: OntologyOutboxDispatcherOptions["onDeliveryFailure"]
  private readonly onError: (error: unknown) => void
  private readonly inFlight = new Set<ClaimedBatch>()
  private draining: Promise<void> | null = null
  private pendingDrain: Promise<void> | null = null
  private stopRequested = false

  constructor(options: OntologyOutboxDispatcherOptions) {
    assertNonblank(options.projectId, "projectId")
    this.projectId = options.projectId
    this.storage = options.storage
    this.events = options.events
    this.batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize")
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs"
    )
    this.initialRetryDelayMs = positiveInteger(
      options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS,
      "initialRetryDelayMs"
    )
    this.maxRetryDelayMs = positiveInteger(
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      "maxRetryDelayMs"
    )
    if (this.maxRetryDelayMs < this.initialRetryDelayMs) {
      throw new Error(
        "[Sixb] Ontology outbox dispatcher maxRetryDelayMs must be at least initialRetryDelayMs."
      )
    }
    this.retryJitterRatio = options.retryJitterRatio ?? DEFAULT_RETRY_JITTER_RATIO
    if (
      !Number.isFinite(this.retryJitterRatio) ||
      this.retryJitterRatio < 0 ||
      this.retryJitterRatio > 1
    ) {
      throw new Error("[Sixb] Ontology outbox dispatcher retryJitterRatio must be between 0 and 1.")
    }
    this.maxIsolationAttempts = positiveInteger(
      options.maxIsolationAttempts ?? DEFAULT_MAX_ISOLATION_ATTEMPTS,
      "maxIsolationAttempts"
    )
    this.shutdownTimeoutMs = nonnegativeInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs"
    )
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.createLeaseId = options.createLeaseId ?? randomUUID
    this.onDeliveryFailure = options.onDeliveryFailure
    this.onError =
      options.onError ?? ((error) => console.error("[Sixb] Outbox dispatcher error:", error))
  }

  /**
   * Publishes all currently due rows without starting an idle polling loop.
   *
   * Concurrent callers share one pass and at most one coalesced follow-up pass. This gives every
   * post-commit notification a chance to observe its own rows without serializing one pass per
   * mutation.
   */
  drain(): Promise<void> {
    if (this.stopRequested) return Promise.resolve()
    if (!this.draining) return this.startDrainPass()

    this.pendingDrain ??= settled(this.draining).then(() => {
      this.pendingDrain = null
      if (!this.stopRequested) return this.startDrainPass()
    })
    return this.pendingDrain
  }

  /** Starts a tracked, best-effort drain without extending mutation latency. */
  notify(): void {
    if (this.stopRequested) return
    void this.drain().catch((error) => this.reportError(error))
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    const active = [this.draining, this.pendingDrain].filter(
      (promise): promise is Promise<void> => promise !== null
    )
    if (active.length === 0) return
    if (
      await settlesWithin(
        Promise.all(active).then(() => undefined),
        this.shutdownTimeoutMs
      )
    ) {
      return
    }

    await this.rescheduleUnsettledForShutdown()
    this.draining = null
    this.pendingDrain = null
  }

  private startDrainPass(): Promise<void> {
    const pass = this.drainAvailable()
    this.draining = pass
    void settled(pass).then(() => {
      if (this.draining === pass) this.draining = null
    })
    return pass
  }

  private async drainAvailable(): Promise<void> {
    for (;;) {
      if (this.stopRequested) return
      const rows = await this.claimBatch()
      if (rows.length === 0) return
      await this.publishClaim(rows)
      if (this.stopRequested || rows.length < this.batchSize) return
    }
  }

  private claimBatch(): Promise<readonly ClaimedOntologyOutboxRow[]> {
    const now = this.now().getTime()
    return this.withOutbox((outbox) =>
      outbox.claim({
        projectId: this.projectId,
        now: new Date(now).toISOString(),
        limit: this.batchSize,
        leaseId: this.createLeaseId(),
        leaseExpiresAt: new Date(now + this.leaseDurationMs).toISOString(),
      })
    )
  }

  private async publishClaim(rows: readonly ClaimedOntologyOutboxRow[]): Promise<void> {
    const claim = new ClaimedBatch(rows)
    this.inFlight.add(claim)
    const pending: PublicationGroup[] = [{ rows }]
    let publishAttempts = 0

    try {
      while (pending.length > 0 && !this.stopRequested) {
        const group = pending.shift()
        if (!group || group.rows.length === 0) continue
        if (publishAttempts >= this.maxIsolationAttempts && group.failure) {
          await this.rescheduleFailed(claim, group.rows, group.failure.error)
          continue
        }
        publishAttempts += 1

        try {
          await this.events.publishEnvelopes(group.rows.map((row) => row.envelope))
        } catch (error) {
          if (group.rows.length > 1 && publishAttempts < this.maxIsolationAttempts) {
            const middle = Math.ceil(group.rows.length / 2)
            pending.unshift(
              { rows: group.rows.slice(middle), failure: { error } },
              { rows: group.rows.slice(0, middle), failure: { error } }
            )
            continue
          }
          await this.rescheduleFailed(claim, group.rows, error)
          continue
        }

        await this.markPublished(claim, group.rows)
      }
    } finally {
      if (this.stopRequested) {
        await this.rescheduleClaimedForShutdown(claim.close())
      }
      this.inFlight.delete(claim)
    }
  }

  private async markPublished(
    claim: ClaimedBatch,
    rows: readonly ClaimedOntologyOutboxRow[]
  ): Promise<void> {
    const settling = claim.take(rows)
    if (settling.length === 0) return
    try {
      await this.withOutbox((outbox) =>
        outbox.markPublished({
          projectId: this.projectId,
          ids: eventIds(settling),
          leaseId: sharedLeaseId(settling),
          publishedAt: this.now().toISOString(),
        })
      )
    } catch (error) {
      this.reportError(error)
      throw error
    }
  }

  private async rescheduleFailed(
    claim: ClaimedBatch,
    rows: readonly ClaimedOntologyOutboxRow[],
    error: unknown
  ): Promise<void> {
    const settling = claim.take(rows)
    if (settling.length === 0) return
    const failedAt = this.now()

    for (const [attempts, attemptRows] of rowsByAttempts(settling)) {
      try {
        await this.withOutbox((outbox) =>
          outbox.reschedule({
            projectId: this.projectId,
            ids: eventIds(attemptRows),
            leaseId: sharedLeaseId(attemptRows),
            availableAt: new Date(failedAt.getTime() + this.retryDelayMs(attempts)).toISOString(),
            error: errorMessage(error),
          })
        )
      } catch (rescheduleError) {
        this.reportError(rescheduleError)
        this.reportDeliveryFailure(error, {
          occurredAt: failedAt.toISOString(),
          attempts,
          eventIds: eventIds(attemptRows),
        })
        throw rescheduleError
      }
      this.reportDeliveryFailure(error, {
        occurredAt: failedAt.toISOString(),
        attempts,
        eventIds: eventIds(attemptRows),
      })
    }
  }

  private retryDelayMs(attempts: number): number {
    const exponent = Math.max(0, Math.min(52, attempts - 1))
    const exponential = Math.min(this.maxRetryDelayMs, this.initialRetryDelayMs * 2 ** exponent)
    const random = this.random()
    const unitRandom = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5
    const jitterFactor = 1 - this.retryJitterRatio + 2 * this.retryJitterRatio * unitRandom
    return Math.min(this.maxRetryDelayMs, Math.max(0, Math.round(exponential * jitterFactor)))
  }

  private async rescheduleClaimedForShutdown(
    rows: readonly ClaimedOntologyOutboxRow[]
  ): Promise<void> {
    if (rows.length === 0) return
    try {
      await this.withOutbox((outbox) =>
        outbox.reschedule({
          projectId: this.projectId,
          ids: eventIds(rows),
          leaseId: sharedLeaseId(rows),
          availableAt: this.now().toISOString(),
          error: SHUTDOWN_RESCHEDULE_ERROR,
        })
      )
    } catch (error) {
      this.reportError(error)
    }
  }

  private async rescheduleUnsettledForShutdown(): Promise<void> {
    for (const claim of [...this.inFlight]) {
      await this.rescheduleClaimedForShutdown(claim.close())
      this.inFlight.delete(claim)
    }
  }

  private withOutbox<T>(run: (outbox: OntologyOutboxStorage) => Promise<T> | T): Promise<T> {
    return this.storage.transaction((tx) => run(tx.ontology.outbox))
  }

  private reportDeliveryFailure(error: unknown, failure: OntologyOutboxDeliveryFailure): void {
    try {
      this.onDeliveryFailure?.(error, failure)
    } catch {
      // Failure observers cannot stop delivery or create an unhandled rejection.
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // Error observers cannot stop delivery or create an unhandled rejection.
    }
  }
}

interface PublicationGroup {
  readonly rows: readonly ClaimedOntologyOutboxRow[]
  readonly failure?: { readonly error: unknown }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[Sixb] Ontology outbox dispatcher ${name} must be a positive integer.`)
  }
  return value
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[Sixb] Ontology outbox dispatcher ${name} must be a nonnegative integer.`)
  }
  return value
}

function assertNonblank(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`[Sixb] Ontology outbox dispatcher ${name} must not be blank.`)
  }
}

function rowsByAttempts(
  rows: readonly ClaimedOntologyOutboxRow[]
): ReadonlyMap<number, readonly ClaimedOntologyOutboxRow[]> {
  const groups = new Map<number, ClaimedOntologyOutboxRow[]>()
  for (const row of rows) {
    const group = groups.get(row.attempts) ?? []
    group.push(row)
    groups.set(row.attempts, group)
  }
  return groups
}

function eventIds(rows: readonly ClaimedOntologyOutboxRow[]): string[] {
  return rows.map((row) => row.envelope.id)
}

function sharedLeaseId(rows: readonly ClaimedOntologyOutboxRow[]): string {
  const leaseId = rows[0]?.leaseId
  if (!leaseId || rows.some((row) => row.leaseId !== leaseId)) {
    throw new Error("[Sixb] Claimed ontology outbox batch does not share one lease.")
  }
  return leaseId
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return message.slice(0, 2_000)
}

/** Awaits a pass without adopting its failure, so one failed drain cannot reject the next. */
function settled(promise: Promise<void>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined
  )
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const result = await Promise.race([
    promise.then(
      () => true as const,
      () => true as const
    ),
    timedOut,
  ])
  if (timer !== undefined) clearTimeout(timer)
  return result
}
