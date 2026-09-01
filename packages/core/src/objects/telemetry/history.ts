import { createSixbError } from "../../errors/internal"
import type { AuthorizedObjectReader } from "../../execution/authorized-object-reader"
import type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesPoint,
  TimeseriesStorage,
} from "../../storage"

export interface TelemetryHistoryOptions {
  readonly storage: TimeseriesStorage
  readonly objectReader: AuthorizedObjectReader
}

export type TelemetryHistoryBatchInput = Omit<TimeseriesHistoryBatchInput, "projectId">

interface SnapshotTelemetryHistoryRequest extends TelemetryHistoryBatchInput {
  readonly maxPointOccurrences?: number
}

/** Read only series selected for the exact object occurrence carried by the nominal reader. */
export async function getTelemetryHistoryBatch(
  input: TelemetryHistoryBatchInput,
  options: TelemetryHistoryOptions
): Promise<readonly TimeseriesHistoryBatchResult[]> {
  // Capture both provider capabilities before reading caller-owned request fields.
  const objectReader = options.objectReader
  const storage = options.storage
  const projectId = objectReader.projectId
  const request = snapshotTelemetryHistoryInput(input, objectReader)

  const uniqueSeries = new Map<string, TimeseriesHistorySeriesInput>()
  for (const series of request.series) {
    const key = seriesKey(series)
    if (!uniqueSeries.has(key)) uniqueSeries.set(key, series)
  }
  const deduplicatedSeries = [...uniqueSeries.values()]
  const readable = await objectReader.canReadObjectPropertiesBatch({
    items: deduplicatedSeries.map(objectPropertySelection),
  })
  const visibility = new Map(
    deduplicatedSeries.map(
      (series, index) => [seriesKey(series), readable[index] === true] as const
    )
  )
  const visibleSeries = deduplicatedSeries.filter(
    (series) => visibility.get(seriesKey(series)) === true
  )

  // The provider receives its own detached request. It must never retain or mutate the canonical
  // series snapshot that admission and the final release check rely on.
  const providerRequest = structuredClone({
    projectId,
    series: visibleSeries,
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.limitPerSeries === undefined ? {} : { limitPerSeries: request.limitPerSeries }),
    ...(request.order === undefined ? {} : { order: request.order }),
  })
  const stored = visibleSeries.length === 0 ? [] : await storage.getHistoryBatch(providerRequest)

  // Fully detach and validate provider-owned data before the final live check. A provider result
  // may contain accessors or a custom iterator; none of that code may run after release admission.
  if (!Array.isArray(stored)) throw invalidTimeseriesProviderResult()
  const storedCount = stored.length
  if (!Number.isSafeInteger(storedCount) || storedCount > visibleSeries.length) {
    throw invalidTimeseriesProviderResult()
  }
  const visibleSeriesKeys = new Set(visibleSeries.map(seriesKey))
  const providerResultBySeries = new Map<string, TimeseriesHistoryBatchResult>()
  for (let index = 0; index < storedCount; index += 1) {
    const providerResult = snapshotProviderResult(stored[index]!, request.limitPerSeries)
    const key = seriesKey(providerResult)
    if (providerResultBySeries.has(key) || !visibleSeriesKeys.has(key)) {
      throw invalidTimeseriesProviderResult()
    }
    for (const point of providerResult.points) {
      assertTimeseriesPointMatchesSeries(projectId, providerResult, point)
    }
    providerResultBySeries.set(key, providerResult)
  }

  // Objects and telemetry do not yet share a portable read snapshot. This second exact check is
  // the release point: a series revoked while the provider was reading is never returned.
  const releaseReadable =
    visibleSeries.length === 0
      ? []
      : await objectReader.canReadObjectPropertiesBatch({
          items: visibleSeries.map(objectPropertySelection),
        })
  const releasableSeriesKeys = new Set(
    visibleSeries.flatMap((series, index) =>
      releaseReadable[index] === true ? [seriesKey(series)] : []
    )
  )

  const releasedPoints = request.series.map((series) =>
    releasableSeriesKeys.has(seriesKey(series))
      ? (providerResultBySeries.get(seriesKey(series))?.points ?? [])
      : []
  )
  const pointOccurrences = releasedPoints.reduce((total, points) => total + points.length, 0)
  if (request.maxPointOccurrences !== undefined && pointOccurrences > request.maxPointOccurrences) {
    throw invalidTimeseriesProviderResult()
  }
  const result = request.series.map((series, index) => ({
    ...series,
    points: releasedPoints[index]!.map((point) => structuredClone(point)),
  }))
  objectReader.assertVisibleOutputWithinLimit(result)
  return result
}

/** Read the latest point only while its exact object property remains selected. */
export async function getLatestTelemetryPoint(
  input: TimeseriesHistorySeriesInput,
  options: TelemetryHistoryOptions
): Promise<TimeseriesPoint | null> {
  const objectReader = options.objectReader
  const storage = options.storage
  const projectId = objectReader.projectId
  const series = snapshotTelemetrySeries(input)
  const readable = await objectReader.canReadObjectProperty(objectPropertySelection(series))
  if (!readable) return visibleLatestResult(null, objectReader)

  const rawResult = await storage.getLatest({ projectId, ...series })
  const result = rawResult === null ? null : snapshotProviderPoint(rawResult)
  if (result) assertTimeseriesPointMatchesSeries(projectId, series, result)

  // See the batch release check above. Revocation during the timeseries read hides the result.
  const releaseReadable = await objectReader.canReadObjectProperty(objectPropertySelection(series))
  if (!releaseReadable) return visibleLatestResult(null, objectReader)

  return visibleLatestResult(result, objectReader)
}

function snapshotTelemetrySeries(
  series: TimeseriesHistorySeriesInput
): TimeseriesHistorySeriesInput {
  if (typeof series !== "object" || series === null || Array.isArray(series)) {
    throw new Error("[Sixb] Telemetry history series must be an object.")
  }
  const objectTypeId = telemetryIdentifier(series.objectTypeId, "objectTypeId")
  const objectId = telemetryIdentifier(series.objectId, "objectId")
  const propertyId = telemetryIdentifier(series.propertyId, "propertyId")
  return structuredClone({ objectTypeId, objectId, propertyId })
}

function assertTimeseriesPointMatchesSeries(
  projectId: string,
  series: TimeseriesHistorySeriesInput,
  point: TimeseriesPoint
): void {
  if (
    typeof point !== "object" ||
    point === null ||
    point.projectId !== projectId ||
    point.objectTypeId !== series.objectTypeId ||
    point.objectId !== series.objectId ||
    point.propertyId !== series.propertyId
  ) {
    throw invalidTimeseriesProviderResult()
  }
}

function snapshotTelemetryHistoryInput(
  input: TelemetryHistoryBatchInput,
  objectReader: AuthorizedObjectReader
): SnapshotTelemetryHistoryRequest {
  const authoredSeries = input.series
  const from = input.from
  const to = input.to
  const limitPerSeries = input.limitPerSeries
  const order = input.order
  if (!Array.isArray(authoredSeries)) {
    throw new Error("[Sixb] Telemetry history series must be an array.")
  }
  if (order !== undefined && order !== "asc" && order !== "desc") {
    throw new Error("[Sixb] Telemetry history order must be 'asc' or 'desc'.")
  }

  // Capture length once and walk by index so proxies cannot change the iteration shape halfway.
  const seriesCount = authoredSeries.length
  const admission = objectReader.admitTelemetryHistoryRead({
    seriesCount,
    ...(limitPerSeries === undefined ? {} : { limitPerSeries }),
  })
  const series: TimeseriesHistorySeriesInput[] = []
  for (let index = 0; index < seriesCount; index += 1) {
    series.push(snapshotTelemetrySeries(authoredSeries[index]!))
  }
  return structuredClone({
    series,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(admission.limitPerSeries === undefined ? {} : { limitPerSeries: admission.limitPerSeries }),
    ...(order === undefined ? {} : { order }),
    ...(admission.maxPointOccurrences === undefined
      ? {}
      : { maxPointOccurrences: admission.maxPointOccurrences }),
  })
}

function objectPropertySelection(series: TimeseriesHistorySeriesInput): {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly propertyId: string
} {
  return {
    objectTypeId: series.objectTypeId,
    primaryId: series.objectId,
    propertyId: series.propertyId,
  }
}

function visibleLatestResult<T extends TimeseriesPoint | null>(
  result: T,
  objectReader: AuthorizedObjectReader
): T {
  objectReader.assertVisibleOutputWithinLimit(result)
  return result
}

function snapshotProviderResult(
  result: TimeseriesHistoryBatchResult,
  maxPointsPerSeries: number | undefined
): TimeseriesHistoryBatchResult {
  try {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw invalidTimeseriesProviderResult()
    }
    const series = snapshotTelemetrySeries(result)
    const authoredPoints = result.points
    if (!Array.isArray(authoredPoints)) throw invalidTimeseriesProviderResult()
    const pointCount = authoredPoints.length
    if (
      !Number.isSafeInteger(pointCount) ||
      (maxPointsPerSeries !== undefined && pointCount > maxPointsPerSeries)
    ) {
      throw invalidTimeseriesProviderResult()
    }
    const points: TimeseriesPoint[] = []
    for (let index = 0; index < pointCount; index += 1) {
      points.push(snapshotProviderPoint(authoredPoints[index]!))
    }
    return { ...series, points }
  } catch (error) {
    if (isInvalidTimeseriesProviderResult(error)) throw error
    throw invalidTimeseriesProviderResult(error)
  }
}

function snapshotProviderPoint(point: TimeseriesPoint): TimeseriesPoint {
  try {
    const snapshot = structuredClone(point)
    if (!snapshot || typeof snapshot !== "object") throw invalidTimeseriesProviderResult()
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

function telemetryIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[Sixb] Telemetry history ${field} must be a non-empty string.`)
  }
  return value
}

function seriesKey(series: TimeseriesHistorySeriesInput): string {
  return JSON.stringify([series.objectTypeId, series.objectId, series.propertyId])
}
