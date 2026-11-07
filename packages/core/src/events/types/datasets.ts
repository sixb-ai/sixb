import type { DatasetProducer } from "../../lake-storage/types"
import type { EventEnvelope } from "../envelope"

export interface DatasetVersionCommittedEvent extends EventEnvelope {
  type: "dataset.version.committed"
  topic: "datasets"
  partitionKey: string
  payload: {
    datasetId: string
    versionId: string
    /** Canonical UTC ISO timestamp from the committed immutable dataset version. */
    createdAt: string
    producer: DatasetProducer
    /**
     * As `DatasetVersion.rowsChanged` and `DatasetVersion.lineageChanged`. Absent on events stored
     * before versions recorded them: read a missing flag as changed (`!== false`).
     */
    rowsChanged?: boolean
    lineageChanged?: boolean
  }
}

/**
 * `sixb.datasets.ingest` stored changes and asked for a flush. One event per request: deliveries
 * that arrive while the request is open join it. The orchestrator queues the flush.
 */
export interface DatasetIngestQueuedEvent extends EventEnvelope {
  type: "dataset.ingest.queued"
  topic: "datasets"
  partitionKey: string
  payload: {
    datasetId: string
    /** The request, which names the flush job: a redelivered event queues nothing more. */
    request: number
  }
}

export type DatasetEvent = DatasetVersionCommittedEvent | DatasetIngestQueuedEvent
