import type { TelemetrySeriesRef } from "../../materialization/model"
import type { StoredTelemetryPoint } from "../ontology/materializations"
import type { TimeseriesHistoryBatchInput, TimeseriesPoint, TimeseriesStorage } from "./types"

function pointKey(
  projectId: string,
  objectTypeId: string,
  objectId: string,
  propertyId: string
): string {
  return JSON.stringify([projectId, objectTypeId, objectId, propertyId])
}

export class InMemoryTimeseriesStorage implements TimeseriesStorage {
  // A telemetry point is uniquely identified by (series, at): one value per
  // instant per series. Re-applying the same instant is a last-write-wins
  // upsert, which makes telemetry writes idempotent under replay for free.
  private readonly pointsByKey = new Map<string, Map<number, TimeseriesPoint>>()

  constructor() {
    materializerAdapters.set(this, {
      getExactPoint: (projectId, series, at) => this.getExactPoint(projectId, series, at),
      listLatestForObject: (projectId, objectTypeId, objectId) =>
        this.listLatestForObject(projectId, objectTypeId, objectId),
      applyExactPoint: (projectId, point) => this.applyExactPoint(projectId, point),
    })
  }

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

  private getExactPoint(
    projectId: string,
    series: TelemetrySeriesRef,
    at: string
  ): TimeseriesPoint | null {
    const point =
      this.pointsByKey
        .get(
          pointKey(
            projectId,
            series.object.objectTypeId,
            series.object.primaryId,
            series.propertyId
          )
        )
        ?.get(new Date(at).getTime()) ?? null
    return point ? clonePoint(point) : null
  }

  private listLatestForObject(
    projectId: string,
    objectTypeId: string,
    objectId: string
  ): TimeseriesPoint[] {
    const latest: TimeseriesPoint[] = []
    for (const series of this.pointsByKey.values()) {
      let point: TimeseriesPoint | null = null
      for (const candidate of series.values()) {
        if (
          candidate.projectId !== projectId ||
          candidate.objectTypeId !== objectTypeId ||
          candidate.objectId !== objectId
        ) {
          continue
        }
        if (!point || candidate.at > point.at) point = candidate
      }
      if (point) latest.push(clonePoint(point))
    }
    return latest
  }

  private applyExactPoint(projectId: string, point: StoredTelemetryPoint): void {
    const key = pointKey(
      projectId,
      point.series.object.objectTypeId,
      point.series.object.primaryId,
      point.series.propertyId
    )
    const series = this.pointsByKey.get(key) ?? new Map<number, TimeseriesPoint>()
    series.set(new Date(point.at).getTime(), {
      projectId,
      objectTypeId: point.series.object.objectTypeId,
      objectId: point.series.object.primaryId,
      propertyId: point.series.propertyId,
      value: structuredClone(point.value),
      ...(point.unit !== undefined ? { unit: point.unit } : {}),
      at: new Date(point.at),
      lastCommitId: point.lastCommitId,
    })
    this.pointsByKey.set(key, series)
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

    return points.map(clonePoint)
  }

  async getHistoryBatch(input: TimeseriesHistoryBatchInput): Promise<
    readonly {
      objectTypeId: string
      objectId: string
      propertyId: string
      points: readonly TimeseriesPoint[]
    }[]
  > {
    // Start every read before yielding so one batch observes one in-memory snapshot. The SQL
    // providers get the same guarantee from their single query.
    return Promise.all(
      input.series.map(async (series) => ({
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
      }))
    )
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
    return latest ? clonePoint(latest) : null
  }
}

interface InMemoryTimeseriesMaterializerAdapter {
  getExactPoint(projectId: string, series: TelemetrySeriesRef, at: string): TimeseriesPoint | null
  listLatestForObject(projectId: string, objectTypeId: string, objectId: string): TimeseriesPoint[]
  applyExactPoint(projectId: string, point: StoredTelemetryPoint): void
}

const materializerAdapters = new WeakMap<
  InMemoryTimeseriesStorage,
  InMemoryTimeseriesMaterializerAdapter
>()

/** @internal Exact access for the in-memory ontology provider; not exported from package barrels. */
export function getInMemoryTimeseriesMaterializerAdapter(
  storage: InMemoryTimeseriesStorage
): InMemoryTimeseriesMaterializerAdapter {
  const adapter = materializerAdapters.get(storage)
  if (!adapter) throw new Error("[Sixb] In-memory timeseries materializer adapter is unavailable.")
  return adapter
}

function clonePoint(point: TimeseriesPoint): TimeseriesPoint {
  return {
    ...structuredClone(point),
    value: structuredClone(point.value),
    at: new Date(point.at),
  }
}

export interface InMemoryTimeseriesStorageSnapshot {
  readonly pointsByKey: Map<string, Map<number, TimeseriesPoint>>
}
