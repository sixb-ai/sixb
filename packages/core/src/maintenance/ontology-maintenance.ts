import { type BlobStorage, supportsDirectUpload } from "../blob-storage"
import type { OntologyOutboxDispatcher } from "../events"
import type { VectorIndexingDispatcher } from "../objects/vectors/indexing-dispatch"
import {
  type FileUploadSession,
  FileUploadSessionError,
  type FileUploadSessionStore,
  type Storage,
} from "../storage"
import { storageHeartbeat } from "./heartbeat"
import {
  errorMessage,
  everyMs,
  type MaintenanceFailure,
  MaintenanceLoop,
  type MaintenancePass,
} from "./loop"
import { operationalStatus } from "./status"
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
// Every step is bounded, by a page count or by `intervalMs`, so only a call that hangs reaches this.
const PASS_BUDGET_MS = 5 * 60_000
// An event undelivered this many intervals after it was saved has been missed by that many passes.
const PENDING_LIMIT_INTERVALS = 2
// A request that passed the expiry gate may still be finishing blob I/O, and the API clock may
// run ahead of the database's; the sweep leaves sessions alone until this long past expiry.
const ABANDONED_UPLOAD_SWEEP_DELAY_MS = 5 * 60_000
const ABANDONED_UPLOAD_ABORT_GRACE_MS = 15 * 60_000
// One abandoned candidate of a large projection holds hundreds of thousands of rows. Batches this
// size keep each delete short while clearing such a candidate within a pass.
const ABANDONED_SOURCE_PURGE_BATCH = 50_000
// An expired download URL serves nothing, but its grant records which execution exposed which
// file. It stays this long for that audit trail.
const EXPIRED_FILE_DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000

interface OntologyMaintenanceDependencies {
  readonly projectId: string
  readonly storage: Storage
  readonly dispatcher: OntologyOutboxDispatcher
  readonly vectorIndexing?: VectorIndexingDispatcher
  /** Aborts the provider side of abandoned staged uploads. */
  readonly blobStorage?: BlobStorage
  readonly options?: OntologyMaintenanceOptions
  readonly now?: () => Date
  readonly onError?: (error: unknown, failure: MaintenanceFailure) => void
}

/**
 * Catch-up and retention. The process that commits delivers its own events right away; a pass
 * delivers what it left behind. The orchestrator runs `pass` on its loop; `start()` runs it on a
 * loop of its own, for an embedded host with no orchestrator.
 */
export class OntologyMaintenance {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly dispatcher: OntologyOutboxDispatcher
  private readonly vectorIndexing: VectorIndexingDispatcher | undefined
  private readonly blobStorage: BlobStorage | undefined
  private readonly intervalMs: number
  private readonly publishedOutboxRetentionMs: number
  private readonly terminalSourceRetentionMs: number
  private readonly cleanupLimit: number
  private readonly now: () => Date
  private readonly owners = new Set<symbol>()
  private readonly loop: MaintenanceLoop
  private stopping: Promise<void> | null = null
  private snapshot: OntologyMaintenanceSnapshot

  readonly pass: MaintenancePass

  constructor(dependencies: OntologyMaintenanceDependencies) {
    assertNonblank(dependencies.projectId, "projectId")
    const options = dependencies.options ?? {}
    this.projectId = dependencies.projectId
    this.storage = dependencies.storage
    this.dispatcher = dependencies.dispatcher
    this.vectorIndexing = dependencies.vectorIndexing
    this.blobStorage = dependencies.blobStorage
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
    this.now = dependencies.now ?? (() => new Date())
    this.snapshot = emptySnapshot(this.intervalMs)

    this.pass = everyMs({
      id: "ontology",
      intervalMs: this.intervalMs,
      budgetMs: PASS_BUDGET_MS,
      run: (signal) => this.runPass(signal),
    })
    this.loop = new MaintenanceLoop({
      passes: [this.pass],
      heartbeat: storageHeartbeat(this.projectId, this.storage),
      onError:
        dependencies.onError ??
        ((error) => console.error("[Sixb] Ontology maintenance error:", error)),
      now: this.now,
      shutdownTimeoutMs: nonnegativeInteger(
        options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        "shutdownTimeoutMs"
      ),
    })
  }

  /** Acquires maintenance ownership and starts catch-up without blocking the host from listening. */
  async start(): Promise<OntologyMaintenanceHandle> {
    if (this.stopping) await this.stopping
    const owner = Symbol("ontology-maintenance-owner")
    const startsHosting = this.owners.size === 0
    this.owners.add(owner)
    if (startsHosting) this.loop.start()

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
    return this.loop.runNow()
  }

  /** Force-stops every owner; used during provider shutdown. */
  async stop(): Promise<void> {
    this.owners.clear()
    await this.stopLoop()
  }

  getSnapshot(): OntologyMaintenanceSnapshot {
    return structuredClone(this.snapshot)
  }

  /**
   * Reads what storage holds, not what this process saw: the API answers this and runs no pass, so
   * the heartbeat is what tells it whether anything does.
   */
  async getOperationalStatus(): Promise<OntologyOperationalStatus> {
    const [outbox, heartbeat] = await Promise.all([
      this.storage.ontology.outbox.summarize({ projectId: this.projectId }),
      this.storage.maintenanceHeartbeats?.get({ projectId: this.projectId }) ?? null,
    ])

    return operationalStatus({
      heartbeat,
      outbox,
      pendingLimitMs: this.intervalMs * PENDING_LIMIT_INTERVALS,
      now: this.now(),
    })
  }

  private async runPass(signal: AbortSignal): Promise<void> {
    const started = this.now()
    this.snapshot = { ...this.snapshot, running: true, lastStartedAt: started.toISOString() }

    const failures: unknown[] = []
    await captureFailure(() => this.dispatcher.drain(), failures)
    const vectorIndexing = this.vectorIndexing
    if (vectorIndexing) await captureFailure(() => vectorIndexing.drain(), failures)
    const cleanup = await this.cleanupExpiredRows(started, failures, signal)
    const outbox = await captureFailure(
      () => this.storage.ontology.outbox.summarize({ projectId: this.projectId }),
      failures,
      this.snapshot.outbox
    )
    this.completePass({ started, failures, cleanup, outbox })
  }

  private async cleanupExpiredRows(
    started: Date,
    failures: unknown[],
    signal: AbortSignal
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
    // Plans go first: a source version is cleaned only once its plan is gone.
    const spentPlanRows = await captureFailure(
      () => this.purgeSpentPlans(started, signal),
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
    const abandonedSources = await captureFailure(
      () => this.purgeAbandonedSources(started, signal),
      failures,
      { rowsDeleted: 0, materializationsDeleted: 0 }
    )
    const uploads = this.storage.fileUploadSessions
    if (uploads) {
      // Retire abandoned uploads first: the store never reaps one that is still pending.
      await captureFailure(() => this.retireAbandonedUploads(uploads, started, failures), failures)
      await captureFailure(() => uploads.cleanupExpired(started), failures, 0)
    }
    const downloads = this.storage.fileDownloadGrants
    if (downloads) {
      await captureFailure(
        () =>
          downloads.deleteExpired({
            projectId: this.projectId,
            expiredBefore: new Date(started.getTime() - EXPIRED_FILE_DOWNLOAD_RETENTION_MS),
            limit: this.cleanupLimit,
          }),
        failures,
        0
      )
    }

    // A frame grant lasts an hour; nothing reads one after it expires.
    const artifacts = this.storage.artifacts
    if (artifacts) {
      await captureFailure(
        () =>
          artifacts.deleteExpiredFrameGrants({
            projectId: this.projectId,
            expiredBefore: started,
            limit: this.cleanupLimit,
          }),
        failures,
        0
      )
    }

    return {
      publishedOutboxRowsDeleted,
      terminalSourceRowsDeleted:
        terminalSources.rowsDeleted + abandonedSources.rowsDeleted + spentPlanRows,
      terminalSourceMaterializationsDeleted:
        terminalSources.materializationsDeleted + abandonedSources.materializationsDeleted,
    }
  }

  /** Deletes abandoned candidates batch after batch, until none is left or the pass runs long. */
  private async purgeAbandonedSources(
    started: Date,
    signal: AbortSignal
  ): Promise<{ readonly rowsDeleted: number; readonly materializationsDeleted: number }> {
    let rowsDeleted = 0
    let materializationsDeleted = 0
    while (true) {
      const purged = await this.storage.ontology.sources.purgeAbandoned({
        projectId: this.projectId,
        limit: ABANDONED_SOURCE_PURGE_BATCH,
      })
      rowsDeleted += purged.rowsDeleted
      materializationsDeleted += purged.materializationsDeleted
      const exhausted =
        purged.rowsDeleted + purged.materializationsDeleted < ABANDONED_SOURCE_PURGE_BATCH
      if (exhausted || this.passedInterval(started) || signal.aborted) {
        return { rowsDeleted, materializationsDeleted }
      }
    }
  }

  /** Deletes the plans of candidates that left `ready`, batch after batch, like candidates. */
  private async purgeSpentPlans(started: Date, signal: AbortSignal): Promise<number> {
    let rowsDeleted = 0
    while (true) {
      const purged = await this.storage.ontology.replacementPlans.purge({
        projectId: this.projectId,
        limit: ABANDONED_SOURCE_PURGE_BATCH,
      })
      rowsDeleted += purged
      if (purged < ABANDONED_SOURCE_PURGE_BATCH || this.passedInterval(started) || signal.aborted) {
        return rowsDeleted
      }
    }
  }

  private passedInterval(started: Date): boolean {
    return this.now().getTime() - started.getTime() >= this.intervalMs
  }

  private async retireAbandonedUploads(
    uploads: FileUploadSessionStore,
    now: Date,
    failures: unknown[]
  ): Promise<void> {
    const abandoned = await uploads.listAbandoned({
      projectId: this.projectId,
      now: new Date(now.getTime() - ABANDONED_UPLOAD_SWEEP_DELAY_MS),
      limit: this.cleanupLimit,
    })
    for (const session of abandoned) {
      await captureFailure(() => this.retireAbandonedUpload(uploads, session, now), failures)
    }
  }

  /**
   * Releases one abandoned upload's provider-side parts, then makes its row terminal so
   * `cleanupExpired` can reap it. Throwing records a pass failure and moves on to the next.
   */
  private async retireAbandonedUpload(
    uploads: FileUploadSessionStore,
    session: FileUploadSession,
    now: Date
  ): Promise<void> {
    const blobStorage = this.blobStorage
    const providerUpload = session.providerUpload
    let abortFailure: unknown
    if (providerUpload && blobStorage && supportsDirectUpload(blobStorage)) {
      try {
        await blobStorage.abortUpload({
          uploadId: session.id,
          stagingKey: providerUpload.stagingKey,
          ...(providerUpload.providerUploadId === undefined
            ? {}
            : { providerUploadId: providerUpload.providerUploadId }),
        })
      } catch (error) {
        // Retry on later passes for a bounded time. After that the bucket lifecycle rule owns
        // the parts: a row that can never be aborted would hold a slot in every pass's limit.
        if (now.getTime() - session.expiresAt.getTime() < ABANDONED_UPLOAD_ABORT_GRACE_MS)
          throw error
        abortFailure = error
      }
    }

    try {
      await uploads.abort(session.id)
    } catch (error) {
      // Another pass, or the client, aborted it first.
      if (!(error instanceof FileUploadSessionError && error.reason === "already_aborted")) {
        throw error
      }
    }
    if (abortFailure !== undefined) throw abortFailure
  }

  private completePass(input: {
    readonly started: Date
    readonly failures: readonly unknown[]
    readonly cleanup: OntologyMaintenanceCleanupSnapshot
    readonly outbox: OntologyMaintenanceSnapshot["outbox"]
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
      cleanup: input.cleanup,
    }
    if (failure) throw failure
  }

  private stopLoop(): Promise<void> {
    if (this.stopping) return this.stopping

    this.stopping = this.loop.stop().finally(() => {
      this.stopping = null
    })
    return this.stopping
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
