import type { OntologyOutboxDispatcher } from "../events"
import type { Storage } from "../storage"
import type {
  OntologyMaintenanceCleanupSnapshot,
  OntologyMaintenanceHandle,
  OntologyMaintenanceOptions,
  OntologyMaintenanceSnapshot,
  OntologyOperationalStatus,
} from "./types"

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000
const DEFAULT_CLEANUP_LIMIT = 1_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000
const DEGRADED_ATTEMPT_THRESHOLD = 3
const DEGRADED_FAILURE_THRESHOLD = 2

interface OntologyMaintenanceDependencies {
  readonly projectId: string
  readonly storage: Storage
  readonly dispatcher: OntologyOutboxDispatcher
  readonly options?: OntologyMaintenanceOptions
  readonly now?: () => Date
  readonly onError?: (error: unknown) => void
}

/** API-owned catch-up, retention, and operational snapshot lifecycle. */
export class OntologyMaintenance {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly dispatcher: OntologyOutboxDispatcher
  private readonly intervalMs: number
  private readonly publishedOutboxRetentionMs: number
  private readonly terminalSourceRetentionMs: number
  private readonly cleanupLimit: number
  private readonly shutdownTimeoutMs: number
  private readonly now: () => Date
  private readonly onError: (error: unknown) => void
  private readonly owners = new Set<symbol>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private pass: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private snapshot: OntologyMaintenanceSnapshot

  constructor(dependencies: OntologyMaintenanceDependencies) {
    assertNonblank(dependencies.projectId, "projectId")
    const options = dependencies.options ?? {}
    this.projectId = dependencies.projectId
    this.storage = dependencies.storage
    this.dispatcher = dependencies.dispatcher
    this.intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs")
    this.publishedOutboxRetentionMs = nonnegativeInteger(
      options.publishedOutboxRetentionMs ?? DEFAULT_RETENTION_MS,
      "publishedOutboxRetentionMs"
    )
    this.terminalSourceRetentionMs = nonnegativeInteger(
      options.terminalSourceRetentionMs ?? DEFAULT_RETENTION_MS,
      "terminalSourceRetentionMs"
    )
    this.cleanupLimit = positiveInteger(
      options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT,
      "cleanupLimit"
    )
    this.shutdownTimeoutMs = nonnegativeInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs"
    )
    this.now = dependencies.now ?? (() => new Date())
    // A runtime fills this with the escalation channel, so the fallback is the standalone path —
    // maintenance constructed directly, which is a test or an embedding, not a running project.
    this.onError =
      dependencies.onError ??
      ((error) => console.error("[Sixb] Ontology maintenance error:", error))
    this.snapshot = emptySnapshot(this.intervalMs)
  }

  /** Acquires maintenance ownership and starts catch-up without blocking the host from listening. */
  async start(): Promise<OntologyMaintenanceHandle> {
    if (this.stopping) await this.stopping
    const owner = Symbol("ontology-maintenance-owner")
    const startsHosting = this.owners.size === 0
    this.owners.add(owner)
    if (startsHosting) this.startHostedPass()

    let released = false
    return {
      stop: async () => {
        if (released) return
        released = true
        this.owners.delete(owner)
        if (this.owners.size === 0) await this.stopLoop()
      },
    }
  }

  /** Runs one coalesced pass. Exposed for deterministic hosting and tests. */
  runNow(): Promise<void> {
    this.pass ??= this.runPass().finally(() => {
      this.pass = null
    })
    return this.pass
  }

  /** Force-stops every owner; used during provider shutdown. */
  async stop(): Promise<void> {
    this.owners.clear()
    await this.stopLoop()
  }

  getSnapshot(): OntologyMaintenanceSnapshot {
    return structuredClone(this.snapshot)
  }

  getOperationalStatus(): OntologyOperationalStatus {
    const snapshot = this.getSnapshot()
    const lastActivityAt = latestTimestamp(snapshot.lastStartedAt, snapshot.lastCompletedAt)
    const overdue =
      lastActivityAt !== null &&
      this.now().getTime() - Date.parse(lastActivityAt) > this.intervalMs * 2
    const oldestPendingAt = snapshot.outbox?.oldestPendingAt ?? null
    const pendingTooLong =
      oldestPendingAt !== null &&
      this.now().getTime() - Date.parse(oldestPendingAt) > this.intervalMs * 2
    const repeatedlyFailing = (snapshot.outbox?.maxAttempts ?? 0) >= DEGRADED_ATTEMPT_THRESHOLD
    const degraded =
      snapshot.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD ||
      repeatedlyFailing ||
      pendingTooLong ||
      overdue
    return { status: degraded ? "degraded" : "ok", maintenance: snapshot }
  }

  private startHostedPass(): void {
    void this.runNow()
      .catch((error) => this.reportError(error))
      .finally(() => this.scheduleNextPass())
  }

  private async runPass(): Promise<void> {
    const started = this.now()
    this.snapshot = { ...this.snapshot, running: true, lastStartedAt: started.toISOString() }

    const failures: unknown[] = []
    await captureFailure(() => this.dispatcher.drain(), failures)
    const cleanup = await this.cleanupExpiredRows(started, failures)
    const { outbox, terminalSources } = await this.readOperationalSummaries(failures)
    this.completePass({ started, failures, cleanup, outbox, terminalSources })
  }

  private async cleanupExpiredRows(
    started: Date,
    failures: unknown[]
  ): Promise<OntologyMaintenanceCleanupSnapshot> {
    const publishedOutboxRowsDeleted = await captureFailure(
      () =>
        this.storage.ontology.outbox.purgePublished({
          projectId: this.projectId,
          publishedBefore: new Date(
            started.getTime() - this.publishedOutboxRetentionMs
          ).toISOString(),
          limit: this.cleanupLimit,
        }),
      failures,
      0
    )
    const terminalSources = await captureFailure(
      () =>
        this.storage.ontology.sources.cleanupTerminal({
          projectId: this.projectId,
          terminalBefore: new Date(
            started.getTime() - this.terminalSourceRetentionMs
          ).toISOString(),
          limit: this.cleanupLimit,
        }),
      failures,
      { rowsDeleted: 0, materializationsDeleted: 0 }
    )

    return {
      publishedOutboxRowsDeleted,
      terminalSourceRowsDeleted: terminalSources.rowsDeleted,
      terminalSourceMaterializationsDeleted: terminalSources.materializationsDeleted,
    }
  }

  private async readOperationalSummaries(failures: unknown[]): Promise<{
    readonly outbox: OntologyMaintenanceSnapshot["outbox"]
    readonly terminalSources: OntologyMaintenanceSnapshot["terminalSources"]
  }> {
    const outbox = await captureFailure(
      () => this.storage.ontology.outbox.summarize({ projectId: this.projectId }),
      failures,
      this.snapshot.outbox
    )
    const terminalSummary = await captureFailure(
      () => this.storage.ontology.sources.summarizeTerminal({ projectId: this.projectId }),
      failures,
      this.snapshot.terminalSources
    )
    return { outbox, terminalSources: terminalSummary }
  }

  private completePass(input: {
    readonly started: Date
    readonly failures: readonly unknown[]
    readonly cleanup: OntologyMaintenanceCleanupSnapshot
    readonly outbox: OntologyMaintenanceSnapshot["outbox"]
    readonly terminalSources: OntologyMaintenanceSnapshot["terminalSources"]
  }): void {
    const completed = this.now()
    const failure =
      input.failures.length > 0
        ? new AggregateError(input.failures, "Maintenance pass failed.")
        : null
    this.snapshot = {
      running: false,
      intervalMs: this.intervalMs,
      lastStartedAt: input.started.toISOString(),
      lastCompletedAt: completed.toISOString(),
      lastDurationMs: Math.max(0, completed.getTime() - input.started.getTime()),
      consecutiveFailures: failure ? this.snapshot.consecutiveFailures + 1 : 0,
      lastError: failure ? errorMessage(failure) : null,
      outbox: input.outbox,
      terminalSources: input.terminalSources,
      cleanup: input.cleanup,
    }
    if (failure) this.reportError(failure)
  }

  private scheduleNextPass(): void {
    if (this.owners.size === 0 || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.owners.size === 0) return
      void this.runNow()
        .catch((error) => this.reportError(error))
        .finally(() => this.scheduleNextPass())
    }, this.intervalMs)
    this.timer.unref?.()
  }

  private stopLoop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const activePass = this.pass ?? Promise.resolve()
    const stopping = settlesWithin(activePass, this.shutdownTimeoutMs).then((settled) => {
      if (!settled) {
        this.reportError(
          new Error(`[Sixb] Ontology maintenance did not stop within ${this.shutdownTimeoutMs}ms.`)
        )
      }
    })
    this.stopping = stopping.finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // Maintenance failures stay observable without escaping into runtime lifecycle code.
    }
  }
}

function emptySnapshot(intervalMs: number): OntologyMaintenanceSnapshot {
  return {
    running: false,
    intervalMs,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    consecutiveFailures: 0,
    lastError: null,
    outbox: null,
    terminalSources: null,
    cleanup: null,
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[Sixb] Ontology maintenance ${name} must be a positive integer.`)
  }
  return value
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[Sixb] Ontology maintenance ${name} must be a nonnegative integer.`)
  }
  return value
}

function assertNonblank(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`[Sixb] Ontology maintenance ${name} must not be blank.`)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return [...error.errors].map(errorMessage).join(" | ").slice(0, 2_000)
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return message.slice(0, 2_000)
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
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

async function captureFailure(run: () => Promise<void>, failures: unknown[]): Promise<void>
async function captureFailure<T>(
  run: () => Promise<T>,
  failures: unknown[],
  fallback: T
): Promise<T>
async function captureFailure<T>(
  run: () => Promise<T>,
  failures: unknown[],
  fallback?: T
): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    failures.push(error)
    return fallback
  }
}
