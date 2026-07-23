import { randomUUID } from "node:crypto"
import type { ClaimedOntologyOutboxRow, OntologyOutboxStorage, Storage } from "../storage"
import type { EventsRuntime } from "./runtime"

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_LEASE_DURATION_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000
const DEFAULT_RETRY_JITTER_RATIO = 0.2
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000
const SHUTDOWN_RESCHEDULE_ERROR = "Outbox dispatcher stopped before publication completed."

export interface OntologyOutboxDispatcherOptions {
  readonly projectId: string
  readonly storage: Storage
  readonly events: EventsRuntime
  readonly batchSize?: number
  readonly leaseDurationMs?: number
  readonly pollIntervalMs?: number
  readonly initialRetryDelayMs?: number
  readonly maxRetryDelayMs?: number
  /** Symmetric jitter ratio in the inclusive range 0..1. */
  readonly retryJitterRatio?: number
  readonly shutdownTimeoutMs?: number
  readonly now?: () => Date
  readonly random?: () => number
  readonly createLeaseId?: () => string
  readonly onError?: (error: unknown) => void
}

interface InFlightPublication {
  readonly rows: readonly ClaimedOntologyOutboxRow[]
  settling: boolean
}

/** Lease-based, at-least-once publisher for the authoritative ontology outbox. */
export class OntologyOutboxDispatcher {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly events: EventsRuntime
  private readonly batchSize: number
  private readonly leaseDurationMs: number
  private readonly pollIntervalMs: number
  private readonly initialRetryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly retryJitterRatio: number
  private readonly shutdownTimeoutMs: number
  private readonly now: () => Date
  private readonly random: () => number
  private readonly createLeaseId: () => string
  private readonly onError: (error: unknown) => void
  private inFlight: InFlightPublication | null = null
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private wakeVersion = 0
  private wakeWaiter: (() => void) | null = null

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
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs"
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
    this.shutdownTimeoutMs = nonnegativeInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs"
    )
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.createLeaseId = options.createLeaseId ?? randomUUID
    this.onError =
      options.onError ?? ((error) => console.error("[Sixb] Outbox dispatcher error:", error))
  }

  async start(): Promise<void> {
    if (this.controller !== null) return

    const controller = new AbortController()
    this.controller = controller
    const running = this.run(controller.signal)
    this.running = running
    running
      .catch((error) => this.reportError(error))
      .finally(() => {
        if (this.running === running) {
          this.running = null
          this.controller = null
        }
      })
  }

  /** Hints that new rows are available. Polling remains the correctness fallback. */
  wake(): void {
    this.wakeVersion += 1
    this.wakeWaiter?.()
  }

  async stop(): Promise<void> {
    const controller = this.controller
    const running = this.running
    if (controller === null || running === null) return

    controller.abort()
    this.wake()
    const settlementBudget = Math.min(1_000, Math.ceil(this.shutdownTimeoutMs / 2))
    const drainBudget = this.shutdownTimeoutMs - settlementBudget
    if (await settlesWithin(running, drainBudget)) {
      this.detachRun(controller, running)
      return
    }

    await settlesWithin(this.rescheduleUnsettledForShutdown(), settlementBudget)
    this.inFlight = null
    this.detachRun(controller, running)
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let rows: readonly ClaimedOntologyOutboxRow[]
      try {
        rows = await this.claimBatch()
      } catch (error) {
        this.reportError(error)
        await this.waitForWakeOrPoll(signal)
        continue
      }

      if (rows.length === 0) {
        await this.waitForWakeOrPoll(signal)
        continue
      }

      if (signal.aborted) {
        await this.rescheduleClaimedForShutdown(rows)
        return
      }

      await this.publishBatch(rows)
    }
  }

  private claimBatch(): Promise<readonly ClaimedOntologyOutboxRow[]> {
    const now = this.now().getTime()
    const leaseId = this.createLeaseId()
    return this.withOutbox((outbox) =>
      outbox.claim({
        projectId: this.projectId,
        now: new Date(now).toISOString(),
        limit: this.batchSize,
        leaseId,
        leaseExpiresAt: new Date(now + this.leaseDurationMs).toISOString(),
      })
    )
  }

  private async publishBatch(rows: readonly ClaimedOntologyOutboxRow[]): Promise<void> {
    if (rows.length === 0) return
    const publication: InFlightPublication = { rows, settling: false }
    this.inFlight = publication
    const ids = rows.map((row) => row.envelope.id)
    const leaseId = sharedLeaseId(rows)

    try {
      await this.events.publishEnvelopes(rows.map((row) => row.envelope))
      if (!this.beginSettlement(publication)) return
      try {
        await this.withOutbox((outbox) =>
          outbox.markPublished({
            projectId: this.projectId,
            ids,
            leaseId,
            publishedAt: this.now().toISOString(),
          })
        )
      } catch (error) {
        this.reportError(error)
      }
    } catch (error) {
      if (!this.beginSettlement(publication)) return
      try {
        const failedAt = this.now().getTime()
        for (const [attempts, attemptRows] of rowsByAttempts(rows)) {
          await this.withOutbox((outbox) =>
            outbox.reschedule({
              projectId: this.projectId,
              ids: attemptRows.map((row) => row.envelope.id),
              leaseId,
              availableAt: new Date(failedAt + this.retryDelayMs(attempts)).toISOString(),
              error: errorMessage(error),
            })
          )
        }
      } catch (rescheduleError) {
        this.reportError(rescheduleError)
      }
    } finally {
      if (this.inFlight === publication && publication.settling) {
        this.inFlight = null
      }
    }
  }

  private beginSettlement(publication: InFlightPublication): boolean {
    if (this.inFlight !== publication || publication.settling) return false
    publication.settling = true
    return true
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
          ids: rows.map((row) => row.envelope.id),
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
    const publication = this.inFlight
    if (!publication || !this.beginSettlement(publication)) return
    try {
      await this.rescheduleClaimedForShutdown(publication.rows)
    } finally {
      if (this.inFlight === publication) {
        this.inFlight = null
      }
    }
  }

  private withOutbox<T>(run: (outbox: OntologyOutboxStorage) => Promise<T> | T): Promise<T> {
    return this.storage.transaction((tx) => run(tx.ontology.outbox))
  }

  private async waitForWakeOrPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const observedWakeVersion = this.wakeVersion
    await new Promise<void>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const previousWaiter = this.wakeWaiter
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener("abort", finish)
        if (this.wakeWaiter === finish) this.wakeWaiter = previousWaiter
        resolve()
      }

      this.wakeWaiter = finish
      signal.addEventListener("abort", finish, { once: true })
      timer = setTimeout(finish, this.pollIntervalMs)
      if (this.wakeVersion !== observedWakeVersion) finish()
    })
  }

  private detachRun(controller: AbortController, running: Promise<void>): void {
    if (this.controller === controller) this.controller = null
    if (this.running === running) this.running = null
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // Error observers cannot stop delivery or create an unhandled rejection.
    }
  }
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

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = promise.then(
    () => true as const,
    () => true as const
  )
  const result = await Promise.race([settled, timedOut])
  if (timer !== undefined) clearTimeout(timer)
  return result
}
