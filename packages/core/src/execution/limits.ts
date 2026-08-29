import {
  type ObjectReadExecutionLimits,
  snapshotObjectReadExecutionLimits,
} from "../storage/objects/execution-limits"

/** Query-specific limits resolved independently from authorization grants. */
export interface ObjectQueryExecutionLimits extends ObjectReadExecutionLimits {
  /** Maximum number of root and expanded object occurrences returned by one object query. */
  readonly maxMaterializedObjects: number
}

export interface DelegatedExecutionLimits extends ObjectQueryExecutionLimits {
  /** Maximum number of requested telemetry series in one history read. */
  readonly maxTelemetrySeries: number
  /** Maximum total number of telemetry point occurrences requested by one history read. */
  readonly maxTelemetryPoints: number
}

export const DEFAULT_DELEGATED_EXECUTION_LIMITS: DelegatedExecutionLimits = Object.freeze({
  maxTraversalFacts: 10_000,
  maxMaterializedObjects: 10_000,
  maxTelemetrySeries: 100,
  maxTelemetryPoints: 10_000,
  maxVisibleJsonBytes: 8 * 1024 * 1024,
})

export function snapshotDelegatedExecutionLimits(
  limits: DelegatedExecutionLimits = DEFAULT_DELEGATED_EXECUTION_LIMITS
): DelegatedExecutionLimits {
  const objectRead = snapshotObjectReadExecutionLimits(limits)
  if (!Number.isSafeInteger(limits.maxMaterializedObjects) || limits.maxMaterializedObjects <= 0) {
    throw new Error("[Sixb] maxMaterializedObjects must be a positive safe integer.")
  }
  if (!Number.isSafeInteger(limits.maxTelemetrySeries) || limits.maxTelemetrySeries <= 0) {
    throw new Error("[Sixb] maxTelemetrySeries must be a positive safe integer.")
  }
  if (!Number.isSafeInteger(limits.maxTelemetryPoints) || limits.maxTelemetryPoints <= 0) {
    throw new Error("[Sixb] maxTelemetryPoints must be a positive safe integer.")
  }
  return Object.freeze({
    ...objectRead,
    maxMaterializedObjects: limits.maxMaterializedObjects,
    maxTelemetrySeries: limits.maxTelemetrySeries,
    maxTelemetryPoints: limits.maxTelemetryPoints,
  })
}
