import type { SixbFailure } from "../../errors/types"
import type { SyncRunFailureCode } from "../../storage/sync-runs/types"
import type { EventEnvelope } from "../envelope"

export interface SyncRunStartedEvent extends EventEnvelope {
  type: "sync.run.started"
  topic: "syncs"
  partitionKey: string
  payload: {
    syncId: string
    runId: string
    /** The connection the run reads, on a sync of an OAuth connector. */
    connectionId?: string
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
    /** The connection the run reads, on a sync of an OAuth connector. */
    connectionId?: string
    status: "succeeded" | "failed" | "cancelled"
    datasetId?: string
    versionId?: string
    error?: SixbFailure<SyncRunFailureCode>
  }
}

export type SyncEvent = SyncRunStartedEvent | SyncRunFinishedEvent
