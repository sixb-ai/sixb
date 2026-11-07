import { randomUUID } from "node:crypto"
import type { BlobStorage } from "../blob-storage"
import {
  reportDatasetIngestFlushFailure,
  reportDatasetIngestRejection,
} from "../error-reporting/capability"
import { captureSixbFailure } from "../errors/internal"
import type { DomainEventLog } from "../events/service"
import { LakeConcurrencyError, LakeValueRefusedError } from "../lake-storage/errors"
import { getDatasetPrimaryKeyColumns } from "../lake-storage/merge-validation"
import {
  DatasetSequenceConflictError,
  datasetSequenceChange,
} from "../lake-storage/source-ordering"
import type { DatasetProducer, DatasetVersion, LakeStorage } from "../lake-storage/types"
import {
  type DatasetIngestBatch,
  type DatasetIngestChange,
  type DatasetIngestDelivery,
  type DatasetIngestLease,
  DatasetIngestLeaseLostError,
  type DatasetIngestStorage,
} from "../storage/dataset-ingest"
import { DatasetValidationError } from "./errors"
import { type DatasetIngestFlushQueue, tryEnqueueIngestFlush } from "./ingest-flush-job"
import type { DatasetDefinition } from "./types"
import { lakeDatasetDefinition, writeDataset } from "./write"

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

/** A version is looked for among this many of the dataset's newest. */
const LOOKUP_VERSIONS = 200
/** Clocks of the process that committed and of the database that dated the batch may differ. */
const LOOKUP_CLOCK_SKEW_MS = 60_000

const CONCURRENCY_ATTEMPTS = 3

export type DatasetIngestFlushOutcome =
  | {
      readonly kind: "flushed"
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
   * Writes the dataset's ingested changes to the lake, one version per batch, until its inbox is
   * empty or the job's budget is spent; then the next job continues. Resumes a batch a flush that
   * died left in flight, and never writes one twice.
   */
  flush(datasetId: string, signal: AbortSignal): Promise<DatasetIngestFlushOutcome>
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

  return {
    enabled,
    flush: async (datasetId, signal) =>
      new DatasetIngestFlush(dependencies, datasetId, signal).run(),
  }
}

interface CommittedBatch {
  readonly version: DatasetVersion | null
  readonly producer: DatasetProducer
  readonly deliveries: readonly DatasetIngestDelivery[]
}

/** One job's flush of one dataset. */
class DatasetIngestFlush {
  private readonly inbox: DatasetIngestStorage
  private readonly owner = `flush-owner_${randomUUID()}`
  private readonly lost = new AbortController()
  private readonly signal: AbortSignal
  /** Until when the lease is surely ours: no other flush can have taken it before. */
  private ownedUntil = 0

  constructor(
    private readonly dependencies: DatasetIngestRuntimeDependencies,
    private readonly datasetId: string,
    signal: AbortSignal
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
    const dataset = this.dependencies.datasets.getById(this.datasetId)
    if (!dataset) {
      throw new Error(
        `[Sixb] Dataset '${this.datasetId}' is not registered; its ingested changes wait in the inbox until it is.`
      )
    }

    const startedAt = Date.now()
    let batch = lease.inFlight
    let resumed = batch !== null
    let versions = 0
    let deliveries = 0

    for (;;) {
      this.signal.throwIfAborted()

      if (batch === null) {
        if (Date.now() - startedAt >= BUDGET_MS) {
          await this.requestAgain(lease)
          return { kind: "flushed", versions, deliveries }
        }

        batch = await this.inbox.takeBatch({
          lease,
          flushId: `flush_${randomUUID()}`,
          maxChanges: DATASET_INGEST_MAX_CHANGES,
        })
        // Nothing pending: the batch released the lease.
        if (batch === null) return { kind: "flushed", versions, deliveries }
        resumed = false
      }

      const committed = await this.commit(dataset, lease, batch, resumed)

      // Announced before the batch is deleted: a flush that dies in between leaves the batch in
      // flight, and the one that resumes it finds the version and announces it again.
      if (committed.version) {
        versions += 1
        await this.announce(dataset, committed)
      }

      await this.inbox.complete({ lease, flushId: batch.flushId })

      deliveries += committed.deliveries.length
      batch = null
    }
  }

  /**
   * Writes the batch as one merge version, unless the lake already holds it: a resumed batch, or
   * one whose commit lost a race, may have been committed by a flush that did not live to delete
   * it. Deliveries the lake refuses are dropped and reported, and the rest committed.
   */
  private async commit(
    dataset: DatasetDefinition,
    lease: DatasetIngestLease,
    batch: DatasetIngestBatch,
    resumed: boolean
  ): Promise<CommittedBatch> {
    let deliveries = batch.deliveries
    const producerOf = (oldest: DatasetIngestDelivery): DatasetProducer => ({
      kind: "ingest",
      id: oldest.executionId,
      runId: batch.flushId,
    })

    if (resumed) {
      const version = await this.findCommitted(batch)
      if (version) return { version, producer: version.producer ?? { kind: "ingest" }, deliveries }
    }

    for (let attempt = 1; ; attempt += 1) {
      const oldest = deliveries[0]
      if (!oldest) return { version: null, producer: { kind: "ingest" }, deliveries }

      const producer = producerOf(oldest)

      try {
        await this.assertOwned(lease)

        const result = await writeDataset({
          lakeStorage: this.dependencies.lakeStorage,
          blobStorage: this.dependencies.blobStorage,
          dataset,
          mode: "merge",
          signal: this.signal,
          producer,
          sourceLabel: `[Sixb] Dataset '${dataset.id}' ingested change`,
          readValues: async () => this.values(lease, batch.flushId),
          // Only a change found invalid is refused. An error reading what it references, such as
          // blob storage not answering, fails the attempt, which is retried.
          mapValidationError: (error, value) =>
            error instanceof DatasetValidationError ? new RefusedChange(value, error) : error,
        })

        return {
          version: result.outcome === "created" ? result.version : null,
          producer,
          deliveries,
        }
      } catch (error) {
        const refused = await this.refusedChange(dataset, lease, batch, error)

        if (refused) {
          await this.reject(dataset, lease, batch, refused)
          deliveries = deliveries.filter((delivery) => delivery.id !== refused.value.delivery.id)
          continue
        }

        if (error instanceof LakeConcurrencyError && attempt < CONCURRENCY_ATTEMPTS) {
          const version = await this.findCommitted(batch)
          if (version) return { version, producer, deliveries }
          continue
        }

        // A value the lake cannot hold, such as a decimal past its precision, would otherwise
        // fail the batch on every attempt: find the deliveries it comes from.
        const isolated = isLakeRefusal(error)
          ? await this.isolate(dataset, lease, batch, producer)
          : []

        if (isolated.length > 0) {
          for (const refused of isolated) {
            await this.reject(dataset, lease, batch, refused)
          }
          const ids = new Set(isolated.map((refused) => refused.value.delivery.id))
          deliveries = deliveries.filter((delivery) => !ids.has(delivery.id))
          continue
        }

        throw error
      }
    }
  }

  /**
   * The deliveries the lake refuses when it stages each one alone, each with its first refused
   * change. Staging writes nothing: the merge is abandoned.
   *
   * A lone delivery the lake refuses is refused too, or one bad value would block the dataset.
   * When every delivery of a larger batch is refused, the lake is failing, not the changes: none
   * is refused, and the attempt fails to be retried.
   */
  private async isolate(
    dataset: DatasetDefinition,
    lease: DatasetIngestLease,
    batch: DatasetIngestBatch,
    producer: DatasetProducer
  ): Promise<RefusedChange[]> {
    const refused: RefusedChange[] = []
    let staged = 0

    for await (const { delivery, changes } of this.inbox.readChanges({
      lease,
      flushId: batch.flushId,
    })) {
      staged += 1
      const error = await this.stage(dataset, producer, changes)
      if (error === null) continue

      const changeIndex = await this.firstRefusedChange(dataset, producer, changes)
      const value = changes[changeIndex] ?? changes[0]
      if (value) refused.push(new RefusedChange({ value, delivery, changeIndex }, error))
    }

    if (staged > 1 && refused.length === staged) return []
    return refused
  }

  /** The lake's refusal of these changes, staged in a merge it then abandons; null if it accepts. */
  private async stage(
    dataset: DatasetDefinition,
    producer: DatasetProducer,
    changes: readonly DatasetIngestChange[]
  ): Promise<unknown> {
    const session = await this.dependencies.lakeStorage.beginMerge({
      dataset: lakeDatasetDefinition(dataset),
      producer,
    })

    try {
      await session.writeChanges(changes)
      return null
    } catch (error) {
      if (isLakeRefusal(error)) return error
      throw error
    } finally {
      await session.abort().catch(() => {})
    }
  }

  /** The refused change: the end of the shortest prefix of the delivery the lake refuses. */
  private async firstRefusedChange(
    dataset: DatasetDefinition,
    producer: DatasetProducer,
    changes: readonly DatasetIngestChange[]
  ): Promise<number> {
    let low = 0
    let high = changes.length - 1

    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const refused = await this.stage(dataset, producer, changes.slice(0, middle + 1))

      if (refused === null) low = middle + 1
      else high = middle
    }

    return low
  }

  /** The batch's changes, in inbox order, each with where it came from. */
  private async *values(lease: DatasetIngestLease, flushId: string): AsyncIterable<BatchValue> {
    for await (const { delivery, changes } of this.inbox.readChanges({ lease, flushId })) {
      for (const [changeIndex, change] of changes.entries()) {
        yield { value: change, delivery, changeIndex }
      }
    }
  }

  /** A version of this batch among the dataset's newest, dated from when it took its deliveries. */
  private async findCommitted(batch: DatasetIngestBatch): Promise<DatasetVersion | null> {
    const versions = await this.dependencies.lakeStorage.listVersions(
      this.datasetId,
      LOOKUP_VERSIONS
    )
    const oldestPossible = batch.startedAt.getTime() - LOOKUP_CLOCK_SKEW_MS

    for (const version of versions) {
      if (version.producer?.kind === "ingest" && version.producer.runId === batch.flushId) {
        return version
      }
      if (version.createdAt.getTime() < oldestPossible) return null
    }

    if (versions.length < LOOKUP_VERSIONS) return null

    throw new Error(
      `[Sixb] Dataset '${this.datasetId}' committed more than ${LOOKUP_VERSIONS} versions since flush '${batch.flushId}' started; cannot tell whether it committed.`
    )
  }

  /** The change a failed write refuses, if the failure names one. */
  private async refusedChange(
    dataset: DatasetDefinition,
    lease: DatasetIngestLease,
    batch: DatasetIngestBatch,
    error: unknown
  ): Promise<RefusedChange | null> {
    if (error instanceof RefusedChange) return error
    if (error instanceof DatasetSequenceConflictError) {
      return this.findConflicting(dataset, lease, batch, error)
    }
    return null
  }

  /**
   * The change the lake refused for a tie: the first one at its key and sequence with its content.
   * An earlier change at that key, sequence and content would have been accepted, and the refused
   * one with it.
   */
  private async findConflicting(
    dataset: DatasetDefinition,
    lease: DatasetIngestLease,
    batch: DatasetIngestBatch,
    conflict: DatasetSequenceConflictError
  ): Promise<RefusedChange | null> {
    for await (const value of this.values(lease, batch.flushId)) {
      const { key, sequence, content } = datasetSequenceChange(dataset, value.value)
      if (key === conflict.key && sequence === conflict.sequence && content === conflict.content) {
        return new RefusedChange(value, conflict)
      }
    }

    return null
  }

  private async reject(
    dataset: DatasetDefinition,
    lease: DatasetIngestLease,
    batch: DatasetIngestBatch,
    refused: RefusedChange
  ): Promise<void> {
    const { delivery, changeIndex, value } = refused.value
    await this.inbox.reject({ lease, flushId: batch.flushId, deliveryIds: [delivery.id] })

    const sequence = dataset.sequenceBy === undefined ? undefined : sequenceOf(dataset, value)
    reportDatasetIngestRejection(this.dependencies.reporter, refused.cause, {
      projectId: this.dependencies.projectId,
      datasetId: dataset.id,
      deliveryId: delivery.id,
      executionId: delivery.executionId,
      changeIndex,
      key: keyOf(dataset, value),
      ...(sequence === undefined ? {} : { sequence }),
      failure: captureSixbFailure(refused.cause, {
        allowedCodes: ["dataset.change_refused"],
        defaultCode: "dataset.change_refused",
      }),
    })
  }

  /** Appends `dataset.version.committed`. A failure fails the attempt, which announces again. */
  private async announce(dataset: DatasetDefinition, committed: CommittedBatch): Promise<void> {
    const { version, producer, deliveries } = committed
    if (!version) return

    await this.dependencies.events.append({
      events: [
        {
          type: "dataset.version.committed",
          payload: {
            datasetId: dataset.id,
            versionId: version.versionId,
            createdAt: version.createdAt.toISOString(),
            producer,
            rowsChanged: version.rowsChanged,
            lineageChanged: version.lineageChanged,
          },
        },
      ],
      ...(deliveries[0] ? { correlationId: deliveries[0].correlationId } : {}),
    })
  }

  /** The budget is spent: leaves what remains to the next job, as `ingest` asks for one. */
  private async requestAgain(lease: DatasetIngestLease): Promise<void> {
    const { request } = await this.inbox.handOver({ lease })

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

interface BatchValue {
  readonly value: DatasetIngestChange
  readonly delivery: DatasetIngestDelivery
  readonly changeIndex: number
}

/** A change of the batch the lake refuses: its delivery is dropped. */
class RefusedChange extends Error {
  constructor(
    readonly value: BatchValue,
    override readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/**
 * The lake refusing a value of the changes, not failing itself: only this isolates and refuses
 * deliveries. Any other error, its own state included, is an outage that is retried.
 */
function isLakeRefusal(error: unknown): boolean {
  return error instanceof LakeValueRefusedError
}

function keyOf(dataset: DatasetDefinition, change: DatasetIngestChange): Record<string, string> {
  const source = change.kind === "upsert" ? change.row : change.key

  return Object.fromEntries(
    (getDatasetPrimaryKeyColumns(dataset) ?? []).map((column) => [column, String(source[column])])
  )
}

function sequenceOf(dataset: DatasetDefinition, change: DatasetIngestChange): string | undefined {
  try {
    return datasetSequenceChange(dataset, change).sequence
  } catch {
    // A change refused for its sequence has none to report.
    return undefined
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
