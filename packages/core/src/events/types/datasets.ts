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
    producer: {
      kind: "sync" | "pipeline"
      id?: string
      runId?: string
      stepId?: string
    }
  }
}

export type DatasetEvent = DatasetVersionCommittedEvent
