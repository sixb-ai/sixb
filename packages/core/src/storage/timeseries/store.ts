import type { StoredTelemetryAppendedEvent } from "../../events"
import type { TimeseriesPoint, TimeseriesStorage } from "./types"

function pointKey(
  projectId: string,
  objectTypeId: string,
  objectId: string,
  propertyId: string
): string {
  return `${projectId}:${objectTypeId}:${objectId}:${propertyId}`
}

export class InMemoryTimeseriesStorage implements TimeseriesStorage {
  private readonly pointsByKey = new Map<string, TimeseriesPoint[]>()
  private readonly appliedEventIds = new Set<string>()

  snapshot(): InMemoryTimeseriesStorageSnapshot {
    return {
      pointsByKey: structuredClone(this.pointsByKey),
      appliedEventIds: new Set(this.appliedEventIds),
    }
  }

  restore(snapshot: InMemoryTimeseriesStorageSnapshot): void {
    this.pointsByKey.clear()
    for (const [key, points] of structuredClone(snapshot.pointsByKey)) {
      this.pointsByKey.set(key, points)
    }

    this.appliedEventIds.clear()
    for (const eventId of snapshot.appliedEventIds) {
      this.appliedEventIds.add(eventId)
    }
  }

  async applyTelemetryAppended(event: StoredTelemetryAppendedEvent): Promise<void> {
    if (this.appliedEventIds.has(event.id)) {
      return
    }

    const key = pointKey(
      event.projectId,
      event.payload.objectTypeId,
      event.payload.objectId,
      event.payload.propertyId
    )

    const points = this.pointsByKey.get(key) ?? []
    points.push({
      projectId: event.projectId,
      objectTypeId: event.payload.objectTypeId,
      objectId: event.payload.objectId,
      propertyId: event.payload.propertyId,
      value: event.payload.value,
      unit: event.payload.unit,
      at: new Date(event.payload.at),
      sourceEventId: event.id,
    })
    this.pointsByKey.set(key, points)
    this.appliedEventIds.add(event.id)
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
    let points =
      from || to
        ? (this.pointsByKey.get(key) ?? []).filter(
            (point) => (!from || point.at >= from) && (!to || point.at <= to)
          )
        : [...(this.pointsByKey.get(key) ?? [])]

    points.sort((a, b) => a.at.getTime() - b.at.getTime())
    if (params.order === "desc") {
      points.reverse()
    }

    if (params.limit !== undefined) {
      points = points.slice(0, Math.max(0, params.limit))
    }

    return points
  }

  async getLatest(params: {
    projectId: string
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<TimeseriesPoint | null> {
    const key = pointKey(params.projectId, params.objectTypeId, params.objectId, params.propertyId)
    const points = this.pointsByKey.get(key)
    if (!points || points.length === 0) {
      return null
    }

    let latest = points[0]
    for (let index = 1; index < points.length; index += 1) {
      const candidate = points[index]
      if (candidate.at > latest.at) {
        latest = candidate
      }
    }
    return latest
  }
}

export interface InMemoryTimeseriesStorageSnapshot {
  readonly pointsByKey: Map<string, TimeseriesPoint[]>
  readonly appliedEventIds: Set<string>
}
