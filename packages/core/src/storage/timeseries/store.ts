import type { StoredTelemetryAppendedEvent } from "../../events"
import type { TimeseriesHistoryBatchInput, TimeseriesPoint, TimeseriesStorage } from "./types"

function pointKey(
  projectId: string,
  objectTypeId: string,
  objectId: string,
  propertyId: string
): string {
  return `${projectId}:${objectTypeId}:${objectId}:${propertyId}`
}

export class InMemoryTimeseriesStorage implements TimeseriesStorage {
  // A telemetry point is uniquely identified by (series, at): one value per
  // instant per series. Re-applying the same instant is a last-write-wins
  // upsert, which makes telemetry writes idempotent under replay for free.
  private readonly pointsByKey = new Map<string, Map<number, TimeseriesPoint>>()

  snapshot(): InMemoryTimeseriesStorageSnapshot {
    return {
      pointsByKey: structuredClone(this.pointsByKey),
    }
  }

  restore(snapshot: InMemoryTimeseriesStorageSnapshot): void {
    this.pointsByKey.clear()
    for (const [key, points] of structuredClone(snapshot.pointsByKey)) {
      this.pointsByKey.set(key, points)
    }
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    const key = pointKey(
      event.projectId,
      event.payload.objectTypeId,
      event.payload.objectId,
      event.payload.propertyId
    )
    const at = new Date(event.payload.at)
    const series = this.pointsByKey.get(key) ?? new Map<number, TimeseriesPoint>()
    series.set(at.getTime(), {
      projectId: event.projectId,
      objectTypeId: event.payload.objectTypeId,
      objectId: event.payload.objectId,
      propertyId: event.payload.propertyId,
      value: event.payload.value,
      unit: event.payload.unit,
      at,
      sourceEventId: event.id,
    })
    this.pointsByKey.set(key, series)
  }

  async applyTelemetryAppendedBatch(
    events: readonly StoredTelemetryAppendedEvent[]
  ): Promise<void> {
    for (const event of events) {
      await this.applyTelemetryAppended(event)
    }
  }

  async getHistory(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
    from?: Date
    to?: Date
    limit?: number
    order?: "asc" | "desc"
  }): Promise<readonly TimeseriesPoint[]> {
    const key = pointKey(params.projectId, params.objectTypeId, params.objectId, params.propertyId)
    const { from, to } = params
    let points = [...(this.pointsByKey.get(key)?.values() ?? [])]
    if (from || to) {
      points = points.filter((point) => (!from || point.at >= from) && (!to || point.at <= to))
    }

    points.sort((a, b) => a.at.getTime() - b.at.getTime())
    if (params.order === "desc") {
      points.reverse()
    }

    if (params.limit !== undefined) {
      points = points.slice(0, Math.max(0, params.limit))
    }

    return points
  }

  async getHistoryBatch(input: TimeseriesHistoryBatchInput): Promise<
    readonly {
      objectTypeId: string
      objectId: string
      propertyId: string
      points: readonly TimeseriesPoint[]
    }[]
  > {
    const results = []
    for (const series of input.series) {
      results.push({
        ...series,
        points: await this.getHistory({
          projectId: input.projectId,
          objectTypeId: series.objectTypeId,
          objectId: series.objectId,
          propertyId: series.propertyId,
          from: input.from,
          to: input.to,
          limit: input.limitPerSeries,
          order: input.order,
        }),
      })
    }
    return results
  }

  async getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null> {
    const series = this.pointsByKey.get(
      pointKey(params.projectId, params.objectTypeId, params.objectId, params.propertyId)
    )
    if (!series || series.size === 0) {
      return null
    }

    let latest: TimeseriesPoint | null = null
    for (const point of series.values()) {
      if (!latest || point.at.getTime() > latest.at.getTime()) {
        latest = point
      }
    }
    return latest
  }
}

export interface InMemoryTimeseriesStorageSnapshot {
  readonly pointsByKey: Map<string, Map<number, TimeseriesPoint>>
}
