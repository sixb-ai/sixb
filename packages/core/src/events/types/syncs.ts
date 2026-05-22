import type { EventEnvelope } from "../envelope"

export interface SyncRunStartedEvent extends EventEnvelope {
  type: "sync.run.started"
  topic: "syncs"
  partitionKey: string
  payload: {
    syncId: string
    runId: string
    startedAt: string
  }
}

export interface SyncRunFinishedEvent extends EventEnvelope {
  type: "sync.run.finished"
  topic: "syncs"
  partitionKey: string
  payload: {
    syncId: string
    runId: string
    status: "succeeded" | "failed" | "cancelled"
    datasetId?: string
    versionId?: string
  }
}

export type SyncEvent = SyncRunStartedEvent | SyncRunFinishedEvent
