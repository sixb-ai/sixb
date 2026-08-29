import { createSixbError } from "../../errors/internal"
import type { AuthorizedObjectReader } from "../../execution/authorized-object-reader"
import type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesPoint,
  TimeseriesStorage,
} from "../../storage"
import { assertVisibleJsonWithinLimit } from "../../storage/objects/execution-limits"
import { assertDelegatedTelemetryPointCount, requireDelegatedTelemetryHistoryLimit } from "./limits"

export interface TelemetryHistoryOptions {
  readonly storage: TimeseriesStorage
  readonly objectReader: AuthorizedObjectReader
}

export type TelemetryHistoryBatchInput = Omit<TimeseriesHistoryBatchInput, "projectId">

export async function getTelemetryHistoryBatch(
  input: TelemetryHistoryBatchInput,
  options: TelemetryHistoryOptions
): Promise<readonly TimeseriesHistoryBatchResult[]> {
  const limits = options.objectReader.delegatedLimits
  const authoredSeries = input.series
  const from = input.from
  const to = input.to
  const authoredLimitPerSeries = input.limitPerSeries
  const order = input.order
  if (!Array.isArray(authoredSeries)) {
    throw new Error("[Sixb] Telemetry history series must be an array.")
  }

  // Read the hostile array length once and apply the delegated budget before allocating or walking
  // it. The snapshot loop below uses this captured length, so a Proxy cannot advertise a small
  // preflight length and a much larger length during Array.prototype.map/structuredClone.
  const authoredSeriesCount = authoredSeries.length
  if (limits) {
    requireDelegatedTelemetryHistoryLimit(
      { seriesCount: authoredSeriesCount, limitPerSeries: authoredLimitPerSeries },
      limits
    )
  }

  const request = snapshotTelemetryHistoryInput({
    projectId: options.objectReader.projectId,
    series: authoredSeries,
    seriesCount: authoredSeriesCount,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(authoredLimitPerSeries === undefined ? {} : { limitPerSeries: authoredLimitPerSeries }),
    ...(order === undefined ? {} : { order }),
  })
  const limitPerSeries = limits
    ? requireDelegatedTelemetryHistoryLimit(
        { seriesCount: request.series.length, limitPerSeries: request.limitPerSeries },
        limits
      )
    : request.limitPerSeries

  const uniqueSeries = new Map<string, TimeseriesHistorySeriesInput>()
  for (const series of request.series) {
    const key = seriesKey(series)
    if (!uniqueSeries.has(key)) uniqueSeries.set(key, series)
  }
  const deduplicatedSeries = [...uniqueSeries.values()]
  const readable = await options.objectReader.canReadObjectPropertiesMany({
    items: deduplicatedSeries.map((series) => ({
      objectTypeId: series.objectTypeId,
      primaryId: series.objectId,
      propertyId: series.propertyId,
    })),
  })
  const visibility = new Map(
    deduplicatedSeries.map(
      (series, index) => [seriesKey(series), readable[index] === true] as const
    )
  )

  const visibleSeries = deduplicatedSeries.filter(
    (series) => visibility.get(seriesKey(series)) === true
  )
  const stored =
    visibleSeries.length === 0
      ? []
      : await options.storage.getHistoryBatch({
          projectId: request.projectId,
          series: visibleSeries,
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.to === undefined ? {} : { to: request.to }),
          ...(limitPerSeries === undefined ? {} : { limitPerSeries }),
          ...(request.order === undefined ? {} : { order: request.order }),
        })

  // Object reachability and telemetry live in different providers, and Core currently has no
  // transaction/snapshot primitive shared by both. Rechecking after the fetch makes this the release
  // point: a series revoked during the timeseries read is never returned. A revocation racing after
  // this check cannot be made atomic until providers support one shared read snapshot.
  const releaseReadable =
    visibleSeries.length === 0
      ? []
      : await options.objectReader.canReadObjectPropertiesMany({
          items: visibleSeries.map((series) => ({
            objectTypeId: series.objectTypeId,
            primaryId: series.objectId,
            propertyId: series.propertyId,
          })),
        })
  const releasableSeriesKeys = new Set(
    visibleSeries.flatMap((series, index) =>
      releaseReadable[index] === true ? [seriesKey(series)] : []
    )
  )
  const visibleSeriesKeys = new Set(visibleSeries.map(seriesKey))
  const returnedSeriesKeys = new Set<string>()
  const resultBySeries = new Map<string, TimeseriesHistoryBatchResult>()
  for (const rawResult of stored) {
    const providerResult = snapshotProviderResult(rawResult)
    const key = seriesKey(providerResult)
    if (returnedSeriesKeys.has(key) || !visibleSeriesKeys.has(key)) {
      throw invalidTimeseriesProviderResult()
    }
    returnedSeriesKeys.add(key)
    if (limitPerSeries !== undefined && providerResult.points.length > limitPerSeries) {
      throw invalidTimeseriesProviderResult()
    }
    for (const point of providerResult.points) {
      assertTimeseriesPointMatchesSeries(request.projectId, providerResult, point)
    }
    if (releasableSeriesKeys.has(key)) resultBySeries.set(key, providerResult)
  }
  const result = request.series.map((series) => ({
    ...series,
    points:
      resultBySeries.get(seriesKey(series))?.points.map((point) => structuredClone(point)) ?? [],
  }))
  if (limits) {
    let pointCount = 0
    for (const series of result) {
      pointCount += series.points.length
      assertDelegatedTelemetryPointCount(pointCount, limits)
    }
    assertVisibleJsonWithinLimit(result, limits)
  }
  return result
}

export async function getLatestTelemetryPoint(
  input: TimeseriesHistorySeriesInput,
  options: TelemetryHistoryOptions
): Promise<TimeseriesPoint | null> {
  const series = snapshotTelemetrySeries(input)
  const readable = await options.objectReader.canReadObjectProperty({
    objectTypeId: series.objectTypeId,
    primaryId: series.objectId,
    propertyId: series.propertyId,
  })
  if (!readable) return visibleLatestResult(null, options.objectReader)

  const rawResult = await options.storage.getLatest({
    ...series,
    projectId: options.objectReader.projectId,
  })

  // See the batch comment above: without a shared Object/Timeseries snapshot, a post-fetch exact
  // check is the strongest release-time revocation guarantee Core can provide.
  const releaseReadable = await options.objectReader.canReadObjectProperty({
    objectTypeId: series.objectTypeId,
    primaryId: series.objectId,
    propertyId: series.propertyId,
  })
  if (!releaseReadable) return visibleLatestResult(null, options.objectReader)

  const result = rawResult === null ? null : structuredClone(rawResult)
  if (result) assertTimeseriesPointMatchesSeries(options.objectReader.projectId, series, result)
  return visibleLatestResult(result, options.objectReader)
}

export function snapshotTelemetrySeries(
  series: TimeseriesHistorySeriesInput
): TimeseriesHistorySeriesInput {
  if (typeof series !== "object" || series === null) {
    throw new Error("[Sixb] Telemetry history series must be an object.")
  }
  return structuredClone({
    objectTypeId: series.objectTypeId,
    objectId: series.objectId,
    propertyId: series.propertyId,
  })
}

export function assertTimeseriesPointMatchesSeries(
  projectId: string,
  series: TimeseriesHistorySeriesInput,
  point: TimeseriesPoint
): void {
  if (
    point.projectId !== projectId ||
    point.objectTypeId !== series.objectTypeId ||
    point.objectId !== series.objectId ||
    point.propertyId !== series.propertyId
  ) {
    throw invalidTimeseriesProviderResult()
  }
}

function snapshotTelemetryHistoryInput(
  input: TimeseriesHistoryBatchInput & { readonly seriesCount: number }
): TimeseriesHistoryBatchInput {
  const projectId = input.projectId
  const series = input.series
  const seriesCount = input.seriesCount
  const from = input.from
  const to = input.to
  const limitPerSeries = input.limitPerSeries
  const order = input.order
  if (!Number.isSafeInteger(seriesCount) || seriesCount < 0) {
    throw new Error("[Sixb] Telemetry history series length must be a non-negative safe integer.")
  }
  const snapshottedSeries: TimeseriesHistorySeriesInput[] = []
  for (let index = 0; index < seriesCount; index += 1) {
    snapshottedSeries.push(snapshotTelemetrySeries(series[index]!))
  }

  return structuredClone({
    projectId,
    series: snapshottedSeries,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(limitPerSeries === undefined ? {} : { limitPerSeries }),
    ...(order === undefined ? {} : { order }),
  })
}

function visibleLatestResult<T extends TimeseriesPoint | null>(
  result: T,
  objectReader: AuthorizedObjectReader
): T {
  const limits = objectReader.delegatedLimits
  if (limits) assertVisibleJsonWithinLimit(result, limits)
  return result
}

function snapshotProviderResult(
  result: TimeseriesHistoryBatchResult
): TimeseriesHistoryBatchResult {
  try {
    const snapshot = structuredClone(result)
    if (!Array.isArray(snapshot.points)) throw invalidTimeseriesProviderResult()
    return snapshot
  } catch (error) {
    if (isInvalidTimeseriesProviderResult(error)) throw error
    throw invalidTimeseriesProviderResult(error)
  }
}

function invalidTimeseriesProviderResult(cause?: unknown): Error {
  return createSixbError(
    "internal.unexpected",
    "[Sixb] Timeseries storage returned data outside the requested series.",
    cause === undefined ? {} : { cause }
  )
}

function isInvalidTimeseriesProviderResult(
  error: unknown
): error is Error & { readonly code: "internal.unexpected" } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "internal.unexpected" &&
    error.message === "[Sixb] Timeseries storage returned data outside the requested series."
  )
}

function seriesKey(series: TimeseriesHistorySeriesInput): string {
  return JSON.stringify([series.objectTypeId, series.objectId, series.propertyId])
}
