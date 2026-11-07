import type { BlobStorage } from "../blob-storage"
import { reportDatasetIngestRejection } from "../error-reporting/capability"
import { captureSixbFailure } from "../errors/internal"
import type { DomainEventLog } from "../events/service"
import { LakeConcurrencyError, LakeValueRefusedError } from "../lake-storage/errors"
import { getDatasetPrimaryKeyColumns } from "../lake-storage/merge-validation"
import {
  DatasetSequenceConflictError,
  datasetSequenceChange,
} from "../lake-storage/source-ordering"
import type { DatasetProducer, DatasetVersion, LakeStorage } from "../lake-storage/types"
import type {
  DatasetIngestBatch,
  DatasetIngestChange,
  DatasetIngestDelivery,
  DatasetIngestLease,
  DatasetIngestStorage,
} from "../storage/dataset-ingest"
import { DatasetValidationError } from "./errors"
import { datasetDefinitionHash } from "./ingest-flush-job"
import { findProducedVersion } from "./produced-version"
import type { DatasetDefinition } from "./types"
import { writeDataset } from "./write"

const CONCURRENCY_ATTEMPTS = 3

export interface IngestBatchWriterInput {
  readonly projectId: string
  readonly inbox: DatasetIngestStorage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: Pick<BlobStorage, "stat">
  readonly events: Pick<DomainEventLog, "append">
  /** Where refused changes are reported: the host. */
  readonly reporter: object
  readonly dataset: DatasetDefinition
  readonly lease: DatasetIngestLease
  readonly signal: AbortSignal
  /** Stops a flush that lost its lease, right before it writes. */
  assertOwned(): Promise<void>
}

interface CommittedBatch {
  readonly version: DatasetVersion | null
  readonly producer: DatasetProducer
  readonly deliveries: readonly DatasetIngestDelivery[]
}

/**
 * Writes one batch of a dataset's inbox to the lake and tells whoever listens. A commit and the
 * inbox are not one transaction, so what a batch left behind is found in the lake, by its flush id.
 */
export class IngestBatchWriter {
  constructor(private readonly input: IngestBatchWriterInput) {}

  /**
   * Writes the batch as one merge version, unless the lake already holds it: a resumed batch, or
   * one whose commit lost a race, may have been committed by a flush that did not live to delete
   * it. Deliveries the lake refuses are dropped and reported, and the rest committed.
   */
  async commit(batch: DatasetIngestBatch, resumed: boolean): Promise<CommittedBatch> {
    let deliveries = batch.deliveries

    if (resumed) {
      const version = await this.findCommitted(batch)
      if (version) return { version, producer: version.producer ?? { kind: "ingest" }, deliveries }
    }

    for (let attempt = 1; ; attempt += 1) {
      const oldest = deliveries[0]
      if (!oldest) return { version: null, producer: { kind: "ingest" }, deliveries }

      const producer: DatasetProducer = {
        kind: "ingest",
        id: oldest.executionId,
        runId: batch.flushId,
      }

      try {
        return { version: await this.write(batch, producer), producer, deliveries }
      } catch (error) {
        const refused = await this.refusedChange(batch, error)

        if (refused) {
          await this.reject(batch, refused)
          deliveries = deliveries.filter((delivery) => delivery.id !== refused.value.delivery.id)
          continue
        }

        if (!(error instanceof LakeConcurrencyError) || attempt >= CONCURRENCY_ATTEMPTS) {
          throw error
        }

        const version = await this.findCommitted(batch)
        if (version) return { version, producer, deliveries }
      }
    }
  }

  /** The version the batch made, or null when its changes changed nothing. */
  private async write(
    batch: DatasetIngestBatch,
    producer: DatasetProducer
  ): Promise<DatasetVersion | null> {
    const { dataset, signal, lakeStorage, blobStorage } = this.input

    await this.input.assertOwned()

    const result = await writeDataset({
      lakeStorage,
      blobStorage,
      dataset,
      mode: "merge",
      signal,
      producer,
      sourceLabel: `[Sixb] Dataset '${dataset.id}' ingested change`,
      readValues: async () => this.values(batch.flushId),
      // Only a change found invalid is refused. An error reading what it references, such as
      // blob storage not answering, fails the attempt, which is retried.
      mapValidationError: (error, value) =>
        error instanceof DatasetValidationError ? new RefusedChange(value, error) : error,
    })

    return result.outcome === "created" ? result.version : null
  }

  /** The batch's changes, in inbox order, each with where it came from. */
  private async *values(flushId: string): AsyncIterable<BatchValue> {
    const { inbox, lease } = this.input

    for await (const { delivery, changes } of inbox.readChanges({ lease, flushId })) {
      for (const [changeIndex, change] of changes.entries()) {
        yield { value: change, delivery, changeIndex }
      }
    }
  }

  /** A version of this batch among the dataset's newest, dated from when it took its deliveries. */
  private findCommitted(batch: DatasetIngestBatch): Promise<DatasetVersion | null> {
    const { lakeStorage, dataset } = this.input

    return findProducedVersion({
      lakeStorage,
      datasetId: dataset.id,
      producer: { kind: "ingest", runId: batch.flushId },
      since: batch.startedAt,
    })
  }

  /** The change a failed write refuses, if the failure names one. */
  private async refusedChange(
    batch: DatasetIngestBatch,
    error: unknown
  ): Promise<RefusedChange | null> {
    if (error instanceof RefusedChange) return error
    if (error instanceof DatasetSequenceConflictError) return this.findConflicting(batch, error)
    if (error instanceof LakeValueRefusedError) return this.changeAt(batch, error)

    return null
  }

  /** The change the lake refused by its position among the batch's changes. */
  private async changeAt(
    batch: DatasetIngestBatch,
    refusal: LakeValueRefusedError
  ): Promise<RefusedChange | null> {
    let position = 0

    for await (const value of this.values(batch.flushId)) {
      if (position === refusal.changeIndex) return new RefusedChange(value, refusal)
      position += 1
    }

    return null
  }

  /**
   * The change the lake refused for a tie: the first one at its key and sequence with its content.
   * An earlier change at that key, sequence and content would have been accepted, and the refused
   * one with it.
   */
  private async findConflicting(
    batch: DatasetIngestBatch,
    conflict: DatasetSequenceConflictError
  ): Promise<RefusedChange | null> {
    for await (const value of this.values(batch.flushId)) {
      const { key, sequence, content } = datasetSequenceChange(this.input.dataset, value.value)
      if (key === conflict.key && sequence === conflict.sequence && content === conflict.content) {
        return new RefusedChange(value, conflict)
      }
    }

    return null
  }

  private async reject(batch: DatasetIngestBatch, refused: RefusedChange): Promise<void> {
    const { dataset, inbox, lease, projectId, reporter } = this.input
    const { delivery, changeIndex, value } = refused.value

    // During a rollout a worker can be older than the API that stored this delivery, and refuse a
    // column it has not heard of yet. Failing the attempt keeps the delivery: it is resumed until
    // the worker and the delivery agree, and only then is a refusal about the delivery.
    if (delivery.definitionHash !== datasetDefinitionHash(dataset)) {
      throw new Error(
        `[Sixb] Delivery '${delivery.id}' of dataset '${dataset.id}' was stored under another definition of the dataset; it waits until this worker runs the same code as the API.`,
        { cause: refused.cause }
      )
    }

    await inbox.reject({
      lease,
      flushId: batch.flushId,
      deliveryId: delivery.id,
      reason: refused.message,
    })

    const sequence = dataset.sequenceBy === undefined ? undefined : sequenceOf(dataset, value)
    reportDatasetIngestRejection(reporter, refused.cause, {
      projectId,
      datasetId: dataset.id,
      deliveryId: delivery.id,
      executionId: delivery.executionId,
      changes: delivery.changeCount,
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
  async announce(committed: CommittedBatch): Promise<void> {
    const { dataset, events } = this.input
    const { version, producer, deliveries } = committed
    if (!version) return

    await events.append({
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
