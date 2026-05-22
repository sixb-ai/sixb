import type { StoredTelemetryAppendedEvent } from "../../events"

/**
 * Time-series projection storage for telemetry history.
 */
export interface TimeseriesPoint {
  projectId: string
  objectTypeId: string
  objectId: string
  propertyId: string
  value: unknown
  unit?: string
  at: Date
  sourceEventId?: string
}

export interface TimeseriesStorage {
  applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void>
  applyTelemetryAppendedBatch(events: readonly StoredTelemetryAppendedEvent[]): Promise<void>

  getHistory(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
    from?: Date
    to?: Date
    limit?: number
    order?: "asc" | "desc"
  }): Promise<readonly TimeseriesPoint[]>

  getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null>
}
