import type { MergeChange } from "../../datasets/changes"
import type { DatasetRow } from "../../lake-storage/types"

export type DatasetIngestChange = MergeChange<DatasetRow, DatasetRow>

/** One `ingest` call: its changes wait here until a flush writes them to the lake. */
export interface DatasetIngestDelivery {
  /** Inbox order. Ids grow with each delivery, but a delivery may commit after a later one. */
  readonly id: string
  readonly datasetId: string
  readonly executionId: string
  readonly correlationId: string
  readonly receivedAt: Date
  readonly changeCount: number
  /** Names the dataset definition `ingest` validated it against. */
  readonly definitionHash: string
}

/** The deliveries one flush writes as one version, in inbox order. */
export interface DatasetIngestBatch {
  readonly flushId: string
  /** When the flush first took its deliveries. A version it committed is no older. */
  readonly startedAt: Date
  readonly deliveries: readonly DatasetIngestDelivery[]
}

/** The right to flush one dataset, until `expiresAt` unless renewed. */
export interface DatasetIngestLease {
  readonly projectId: string
  readonly datasetId: string
  readonly owner: string
  readonly expiresAt: Date
  /**
   * A flush that took its deliveries and did not complete: the lake may hold its version or not.
   * Resume it under the same id.
   */
  readonly inFlight: DatasetIngestBatch | null
}

export type AcquireDatasetIngestLeaseResult =
  | { readonly acquired: true; readonly lease: DatasetIngestLease }
  | { readonly acquired: false; readonly busyUntil: Date }

export interface DatasetIngestSummary {
  readonly datasetId: string
  /** Deliveries not yet written to the lake, those a flush has taken included. */
  readonly pendingDeliveries: number
  readonly pendingChanges: number
  readonly oldestReceivedAt: Date | null
  /** The current flush request: a request for these deliveries names it. */
  readonly request: number
  /** Set while a flush holds the dataset. */
  readonly leaseExpiresAt: Date | null
  /** Flush attempts that failed in a row. */
  readonly failureStreak: number
  /** When a flush last completed a batch of this dataset. */
  readonly lastFlushedAt: Date | null
  /** Deliveries refused when they were written, kept for someone to read and send again. */
  readonly rejectedDeliveries: number
}

/** A delivery the lake or its schema refused after `ingest` answered, and all it held. */
export interface DatasetIngestRejection {
  readonly delivery: DatasetIngestDelivery
  readonly rejectedAt: Date
  readonly reason: string
  readonly changes: readonly DatasetIngestChange[]
}

export interface AppendDatasetIngestDeliveryInput {
  readonly projectId: string
  readonly datasetId: string
  readonly executionId: string
  readonly correlationId: string
  /** Names the dataset definition these changes were validated against. */
  readonly definitionHash: string
  /** Validated changes, in the order the lake applies them. At least one. */
  readonly changes: readonly DatasetIngestChange[]
}

export interface DatasetIngestAppendResult {
  readonly delivery: DatasetIngestDelivery
  /** The flush request the delivery opened or joined. */
  readonly flush: DatasetIngestFlushRequest
}

export interface DatasetIngestFlushRequest {
  /** The request a flush job for this dataset is named after. */
  readonly request: number
  /** True for the call that has to ask for a job: the others are covered by the same request. */
  readonly requested: boolean
}

export interface TakeDatasetIngestBatchInput {
  readonly lease: DatasetIngestLease
  readonly flushId: string
  /** Most changes the batch holds, unless one delivery alone holds more. */
  readonly maxChanges: number
}

/**
 * The inbox of ingested changes: `ingest` appends to it, and one flush at a time per dataset
 * writes its deliveries to the lake as one version.
 *
 * Every method is `async`: a storage's operation-scoped facade serializes only async methods.
 */
export interface DatasetIngestStorage {
  /**
   * Stores one delivery and asks for a flush of its dataset, in one transaction. A request already
   * open covers the delivery: a flush that takes a batch closes the request and sees every delivery
   * appended before. One left open for long is asked for again, in case it never got a job.
   */
  append(input: AppendDatasetIngestDeliveryInput): Promise<DatasetIngestAppendResult>

  /** Takes the dataset for one owner, unless another owner's lease is live. */
  acquire(input: {
    readonly projectId: string
    readonly datasetId: string
    readonly owner: string
    readonly leaseMs: number
  }): Promise<AcquireDatasetIngestLeaseResult>

  /** Extends the lease. Null when the owner lost it. */
  renew(input: {
    readonly lease: DatasetIngestLease
    readonly leaseMs: number
  }): Promise<DatasetIngestLease | null>

  /**
   * Closes the open request and takes whole deliveries in inbox order, at least one. With nothing
   * pending it releases the lease instead and returns null: the next request starts a new flush.
   */
  takeBatch(input: TakeDatasetIngestBatchInput): Promise<DatasetIngestBatch | null>

  /** The changes of the batch's deliveries, in inbox order. */
  readChanges(input: {
    readonly lease: DatasetIngestLease
    readonly flushId: string
  }): AsyncIterable<{
    readonly delivery: DatasetIngestDelivery
    readonly changes: readonly DatasetIngestChange[]
  }>

  /** The batch is in the lake: deletes its deliveries and resets the failure streak. */
  complete(input: { readonly lease: DatasetIngestLease; readonly flushId: string }): Promise<void>

  /**
   * Sets a refused delivery aside, whole and out of the way of what follows. The batch keeps the
   * others.
   */
  reject(input: {
    readonly lease: DatasetIngestLease
    readonly flushId: string
    readonly deliveryId: string
    readonly reason: string
  }): Promise<void>

  /** The newest rejected deliveries first, of one dataset or of every dataset. */
  listRejected(input: {
    readonly projectId: string
    readonly datasetId?: string
    readonly limit: number
  }): Promise<readonly DatasetIngestRejection[]>

  /** Deletes the rejected deliveries set aside longer ago than this. */
  purgeRejected(input: { readonly projectId: string; readonly olderThanMs: number }): Promise<void>

  /** Releases the lease after a failed attempt and counts it. The batch stays in flight. */
  fail(input: { readonly lease: DatasetIngestLease }): Promise<{ readonly failureStreak: number }>

  /** Releases the lease without counting a failure. */
  release(input: { readonly lease: DatasetIngestLease }): Promise<void>

  /**
   * Releases the lease and opens a new request for the deliveries a flush leaves, in one
   * transaction. Always a new one: the request open until now may name the job that is ending, and
   * a queue ignores an id it remembers, so asking under it would queue nothing.
   */
  handOver(input: { readonly lease: DatasetIngestLease }): Promise<{ readonly request: number }>

  /**
   * Datasets with pending or rejected deliveries or a flush in progress. All of them without
   * `datasetIds`.
   */
  summarize(input: {
    readonly projectId: string
    readonly datasetIds?: readonly string[]
  }): Promise<readonly DatasetIngestSummary[]>
}
