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

export interface TimeseriesHistorySeriesInput {
  readonly objectTypeId: string
  readonly objectId: string
  readonly propertyId: string
}

export interface TimeseriesHistoryBatchInput {
  readonly projectId: string
  readonly series: readonly TimeseriesHistorySeriesInput[]
  readonly from?: Date
  readonly to?: Date
  readonly limitPerSeries?: number
  readonly order?: "asc" | "desc"
}

export interface TimeseriesHistoryBatchResult extends TimeseriesHistorySeriesInput {
  readonly points: readonly TimeseriesPoint[]
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

  getHistoryBatch(
    input: TimeseriesHistoryBatchInput
  ): Promise<readonly TimeseriesHistoryBatchResult[]>

  getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null>
}
