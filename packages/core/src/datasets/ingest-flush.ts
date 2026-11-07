import { randomUUID } from "node:crypto"
import type { BlobStorage } from "../blob-storage"
import { reportDatasetIngestFlushFailure } from "../error-reporting/capability"
import { captureSixbFailure } from "../errors/internal"
import type { DomainEventLog } from "../events/service"
import { getDatasetPrimaryKeyColumns } from "../lake-storage/merge-validation"
import type { LakeStorage } from "../lake-storage/types"
import {
  type DatasetIngestBatch,
  type DatasetIngestLease,
  DatasetIngestLeaseLostError,
  type DatasetIngestStorage,
} from "../storage/dataset-ingest"
import { IngestBatchWriter } from "./ingest-flush-batch"
import { type DatasetIngestFlushQueue, tryEnqueueIngestFlush } from "./ingest-flush-job"
import type { DatasetDefinition } from "./types"

/** How long a flush holds a dataset without renewing. A holder that dies frees it after this. */
const LEASE_MS = 60_000
const RENEW_EVERY_MS = 15_000

/**
 * A lease renewed less than `LEASE_MS - OWNED_MARGIN_MS` ago is still ours whatever the database
 * says, so a flush checks it there only past that: the margin covers clock adjustments.
 */
const OWNED_MARGIN_MS = 10_000

/** One job stops taking batches after this long; the next job continues. */
const BUDGET_MS = 30_000

/** Most changes one version holds, unless one delivery alone holds more. */
export const DATASET_INGEST_MAX_CHANGES = 10_000

/** Failures in a row after which the dataset is reported. Flushes go on trying. */
const REPORT_AT_FAILURE_STREAK = 5

export type DatasetIngestFlushOutcome =
  | {
      /** `handed-over`: it spent its budget with changes left, for the next flush to write. */
      readonly kind: "flushed" | "handed-over"
      readonly versions: number
      readonly deliveries: number
    }
  /** Another flush holds the dataset until then. */
  | { readonly kind: "busy"; readonly until: Date }

/** A flush attempt failed; its batch stays in the inbox for the next one. */
export class DatasetIngestFlushError extends Error {
  override readonly name = "DatasetIngestFlushError"

  constructor(
    message: string,
    readonly failureStreak: number,
    options: { readonly cause: unknown }
  ) {
    super(message, options)
  }
}

/** Internal entry point for the worker that flushes, and for tests. */
export interface DatasetIngestRuntime {
  /** Whether the host keeps an inbox and registers a dataset `ingest` can write. */
  readonly enabled: boolean
  /**
   * Whether `ingest` writes what it stored before it returns, instead of queueing a job, for a
   * host no lake worker serves. An embedded server turns it on.
   */
  writesInline: boolean
  /**
   * Writes the dataset's ingested changes to the lake, one version per batch, until its inbox is
   * empty or the job's budget is spent; then the next job continues. Resumes a batch a flush that
   * died left in flight, and never writes one twice.
   */
  flush(datasetId: string, signal: AbortSignal): Promise<DatasetIngestFlushOutcome>
  /** Flushes until nothing is left, with no job to continue. Rejects as the flush does. */
  flushAll(datasetId: string, signal: AbortSignal): Promise<void>
}

export interface DatasetIngestRuntimeDependencies {
  readonly projectId: string
  readonly inbox: DatasetIngestStorage | undefined
  readonly lakeStorage: LakeStorage
  readonly blobStorage: Pick<BlobStorage, "stat">
  readonly events: Pick<DomainEventLog, "append">
  /** Where a flush that spent its budget asks for the next one. */
  readonly queue: DatasetIngestFlushQueue
  readonly datasets: {
    list(): readonly DatasetDefinition[]
    getById(datasetId: string): DatasetDefinition | null
  }
  /** Where failures are reported: the host. */
  readonly reporter: object
}

export function createDatasetIngestRuntime(
  dependencies: DatasetIngestRuntimeDependencies
): DatasetIngestRuntime {
  const enabled =
    dependencies.inbox !== undefined &&
    dependencies.datasets.list().some((dataset) => getDatasetPrimaryKeyColumns(dataset) !== null)

  const flush = (datasetId: string, signal: AbortSignal) =>
    new DatasetIngestFlush(dependencies, datasetId, signal, runtime.writesInline).run()

  const runtime: DatasetIngestRuntime = {
    enabled,
    writesInline: false,
    flush,

    async flushAll(datasetId, signal) {
      let outcome = await flush(datasetId, signal)

      while (outcome.kind === "handed-over") {
        outcome = await flush(datasetId, signal)
      }
    },
  }

  return runtime
}

/** One job's flush of one dataset. */
class DatasetIngestFlush {
  private readonly inbox: DatasetIngestStorage
  private readonly owner = `flush-owner_${randomUUID()}`
  private readonly lost = new AbortController()
  private readonly signal: AbortSignal
  /** Until when the lease is surely ours: no other flush can have taken it before. */
  private ownedUntil = 0
  /** Set once the budget ran out with changes left. */
  private handedOver = false

  constructor(
    private readonly dependencies: DatasetIngestRuntimeDependencies,
    private readonly datasetId: string,
    signal: AbortSignal,
    /** Whoever asked goes on after the budget, so no job is queued for what remains. */
    private readonly inline: boolean
  ) {
    if (!dependencies.inbox) {
      throw new Error(
        "[Sixb] Flushing ingested changes requires storage with a dataset ingest inbox."
      )
    }

    this.inbox = dependencies.inbox
    this.signal = AbortSignal.any([signal, this.lost.signal])
  }

  async run(): Promise<DatasetIngestFlushOutcome> {
    const askedAt = Date.now()
    const acquired = await this.inbox.acquire({
      projectId: this.dependencies.projectId,
      datasetId: this.datasetId,
      owner: this.owner,
      leaseMs: LEASE_MS,
    })
    if (!acquired.acquired) return { kind: "busy", until: acquired.busyUntil }

    const { lease } = acquired
    this.owned(askedAt)
    const renewal = setInterval(() => this.renew(lease), RENEW_EVERY_MS)

    try {
      return await this.flushBatches(lease)
    } catch (error) {
      throw await this.failed(lease, error)
    } finally {
      clearInterval(renewal)
    }
  }

  private async flushBatches(lease: DatasetIngestLease): Promise<DatasetIngestFlushOutcome> {
    const writer = this.batchWriter(lease)
    const startedAt = Date.now()
    let versions = 0
    let deliveries = 0

    this.signal.throwIfAborted()

    let next = lease.inFlight
      ? { batch: lease.inFlight, resumed: true }
      : await this.takeNextBatch(lease, startedAt)

    while (next !== null) {
      const { batch, resumed } = next
      const committed = await writer.commit(batch, resumed)

      // Announced before the batch is deleted: a flush that dies in between leaves the batch in
      // flight, and the one that resumes it finds the version and announces it again.
      if (committed.version) {
        versions += 1
        await writer.announce(committed)
      }

      await this.inbox.complete({ lease, flushId: batch.flushId })

      deliveries += committed.deliveries.length
      next = await this.takeNextBatch(lease, startedAt)
    }

    return { kind: this.handedOver ? "handed-over" : "flushed", versions, deliveries }
  }

  private batchWriter(lease: DatasetIngestLease): IngestBatchWriter {
    const { projectId, lakeStorage, blobStorage, events, reporter, datasets } = this.dependencies

    const dataset = datasets.getById(this.datasetId)
    if (!dataset) {
      throw new Error(
        `[Sixb] Dataset '${this.datasetId}' is not registered; its ingested changes wait in the inbox until it is.`
      )
    }

    return new IngestBatchWriter({
      projectId,
      inbox: this.inbox,
      lakeStorage,
      blobStorage,
      events,
      reporter,
      dataset,
      lease,
      signal: this.signal,
      assertOwned: () => this.assertOwned(lease),
    })
  }

  /** The next batch, or null when none is left, or none fits the budget and the next job goes on. */
  private async takeNextBatch(
    lease: DatasetIngestLease,
    startedAt: number
  ): Promise<{ readonly batch: DatasetIngestBatch; readonly resumed: boolean } | null> {
    this.signal.throwIfAborted()

    if (Date.now() - startedAt >= BUDGET_MS) {
      await this.requestAgain(lease)
      return null
    }

    const batch = await this.inbox.takeBatch({
      lease,
      flushId: `flush_${randomUUID()}`,
      maxChanges: DATASET_INGEST_MAX_CHANGES,
    })

    // Nothing pending: the empty take released the lease.
    return batch && { batch, resumed: false }
  }

  /** The budget is spent: leaves what remains to the next job, as `ingest` asks for one. */
  private async requestAgain(lease: DatasetIngestLease): Promise<void> {
    const { request } = await this.inbox.handOver({ lease })

    this.handedOver = true
    if (this.inline) return

    await tryEnqueueIngestFlush(
      this.dependencies.queue,
      this.dependencies.projectId,
      { datasetId: this.datasetId, request },
      { source: "ingest-flush" }
    )
  }

  /**
   * Stops a flush that lost its lease, right before it writes: a flush paused past its lease may
   * find another one resumed its batch and wrote it. A lease renewed recently enough is still ours
   * and costs no round trip. What remains is a pause longer than the lease between this check and
   * the lake's commit; the commit then races the other flush's, which the lake's optimistic merge
   * settles.
   */
  private async assertOwned(lease: DatasetIngestLease): Promise<void> {
    if (Date.now() < this.ownedUntil) return

    const askedAt = Date.now()
    const renewed = await this.inbox.renew({ lease, leaseMs: LEASE_MS })
    if (renewed) {
      this.owned(askedAt)
      return
    }

    throw new DatasetIngestLeaseLostError(
      `[Sixb] Dataset '${this.datasetId}' ingest lease was taken over by another flush.`
    )
  }

  /** The lease was ours when asked at `askedAt`, for one lease from then. */
  private owned(askedAt: number): void {
    this.ownedUntil = askedAt + LEASE_MS - OWNED_MARGIN_MS
  }

  private renew(lease: DatasetIngestLease): void {
    const askedAt = Date.now()
    this.inbox.renew({ lease, leaseMs: LEASE_MS }).then(
      (renewed) => {
        if (renewed) {
          this.owned(askedAt)
          return
        }
        this.lost.abort(
          new DatasetIngestLeaseLostError(
            `[Sixb] Dataset '${this.datasetId}' ingest lease was taken over by another flush.`
          )
        )
      },
      (error) => {
        console.warn(
          `[Sixb] Could not renew the ingest lease of dataset '${this.datasetId}'.`,
          error
        )
      }
    )
  }

  /**
   * Settles a failed attempt. A stopping worker releases the lease, and a lost lease is its new
   * owner's; any other failure is counted, and reported once the dataset has failed enough times
   * in a row.
   */
  private async failed(lease: DatasetIngestLease, error: unknown): Promise<unknown> {
    if (this.lost.signal.aborted) return this.lost.signal.reason
    if (error instanceof DatasetIngestLeaseLostError) return error

    if (this.signal.aborted) {
      await this.inbox.release({ lease }).catch(() => {})
      return error
    }

    const { failureStreak } = await this.inbox.fail({ lease })

    if (failureStreak === REPORT_AT_FAILURE_STREAK) {
      const [summary] = await this.inbox
        .summarize({ projectId: this.dependencies.projectId, datasetIds: [this.datasetId] })
        .catch(() => [])

      reportDatasetIngestFlushFailure(this.dependencies.reporter, error, {
        projectId: this.dependencies.projectId,
        datasetId: this.datasetId,
        failure: captureSixbFailure(error, {
          allowedCodes: ["internal.unexpected", "runtime.cancelled"],
          defaultCode: "internal.unexpected",
        }),
        failureStreak,
        pendingDeliveries: summary?.pendingDeliveries ?? 0,
        oldestReceivedAt: summary?.oldestReceivedAt?.toISOString() ?? null,
        subject: `failed:${lease.inFlight?.flushId ?? "take"}:${lease.owner}`,
      })
    }

    return new DatasetIngestFlushError(
      `[Sixb] Flushing the ingested changes of dataset '${this.datasetId}' failed (${failureStreak} in a row).`,
      failureStreak,
      { cause: error }
    )
  }
}

// Associates each host with its runtime, as the lake retention runtime does.
const runtimes = new WeakMap<object, DatasetIngestRuntime>()

export function registerDatasetIngestRuntime(host: object, runtime: DatasetIngestRuntime): void {
  runtimes.set(host, runtime)
}

/** The host's runtime, or undefined for a host that registered none. */
export function findDatasetIngestRuntime(host: object): DatasetIngestRuntime | undefined {
  return runtimes.get(host)
}

export function getDatasetIngestRuntime(host: object): DatasetIngestRuntime {
  const runtime = runtimes.get(host)
  if (!runtime) {
    throw new Error("[Sixb] Dataset ingestion requires a configured Sixb host.")
  }
  return runtime
}
