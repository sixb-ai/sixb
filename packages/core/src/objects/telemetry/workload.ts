const MAX_DELEGATED_TELEMETRY_HISTORY_SERIES = 100
const MAX_DELEGATED_TELEMETRY_HISTORY_POINTS = 10_000
const DEFAULT_DELEGATED_TELEMETRY_HISTORY_LIMIT_PER_SERIES = 100

export interface TelemetryHistoryReadWorkloadInput {
  readonly seriesCount: number
  readonly limitPerSeries?: number
}

export interface TelemetryHistoryReadAdmission {
  readonly limitPerSeries?: number
  readonly maxPointOccurrences?: number
}

type TelemetryHistoryWorkloadMetric = "series" | "points"

class TelemetryHistoryWorkloadExceededError extends Error {
  readonly name = "TelemetryHistoryWorkloadExceededError"
  readonly code = "telemetry_history_workload_exceeded"

  constructor(
    readonly metric: TelemetryHistoryWorkloadMetric,
    readonly limit: number
  ) {
    super(`[Sixb] Delegated telemetry history exceeded its ${metric} limit (${limit}).`)
  }
}

/** Resolve one history request without exposing the authority that selected its policy. */
export function admitTelemetryHistoryReadWorkload(
  input: TelemetryHistoryReadWorkloadInput,
  delegated: boolean
): TelemetryHistoryReadAdmission {
  const seriesCount = input.seriesCount
  const limitPerSeries = input.limitPerSeries
  if (!Number.isSafeInteger(seriesCount) || seriesCount < 0) {
    throw new Error("[Sixb] Telemetry history series must have a non-negative safe integer length.")
  }
  if (
    limitPerSeries !== undefined &&
    (!Number.isSafeInteger(limitPerSeries) || limitPerSeries < 0)
  ) {
    throw new Error("[Sixb] Telemetry history limit must be a non-negative safe integer.")
  }

  if (!delegated) {
    const admission: TelemetryHistoryReadAdmission =
      limitPerSeries === undefined ? {} : { limitPerSeries }
    return Object.freeze(admission)
  }
  if (seriesCount > MAX_DELEGATED_TELEMETRY_HISTORY_SERIES) {
    throw new TelemetryHistoryWorkloadExceededError(
      "series",
      MAX_DELEGATED_TELEMETRY_HISTORY_SERIES
    )
  }
  if (seriesCount === 0) {
    return Object.freeze({
      ...(limitPerSeries === undefined ? {} : { limitPerSeries }),
      maxPointOccurrences: MAX_DELEGATED_TELEMETRY_HISTORY_POINTS,
    })
  }

  const maxLimitPerSeries = Math.floor(MAX_DELEGATED_TELEMETRY_HISTORY_POINTS / seriesCount)
  const effectiveLimitPerSeries =
    limitPerSeries ??
    Math.min(DEFAULT_DELEGATED_TELEMETRY_HISTORY_LIMIT_PER_SERIES, maxLimitPerSeries)
  if (effectiveLimitPerSeries > maxLimitPerSeries) {
    throw new TelemetryHistoryWorkloadExceededError(
      "points",
      MAX_DELEGATED_TELEMETRY_HISTORY_POINTS
    )
  }

  return Object.freeze({
    limitPerSeries: effectiveLimitPerSeries,
    maxPointOccurrences: MAX_DELEGATED_TELEMETRY_HISTORY_POINTS,
  })
}
