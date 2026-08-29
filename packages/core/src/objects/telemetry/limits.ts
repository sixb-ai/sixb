import type { DelegatedExecutionLimits } from "../../execution/limits"
import { DelegatedExecutionLimitError } from "../../storage/objects/execution-limits"

type TelemetryHistoryLimits = Pick<
  DelegatedExecutionLimits,
  "maxTelemetrySeries" | "maxTelemetryPoints"
>

/**
 * Validate delegated telemetry work before storage and return the required explicit series limit.
 * `seriesCount` counts response occurrences, including duplicates, so remapping cannot amplify the
 * caller's point budget after the storage read.
 */
export function requireDelegatedTelemetryHistoryLimit(
  input: { readonly seriesCount: number; readonly limitPerSeries?: number },
  limits: TelemetryHistoryLimits
): number {
  if (input.seriesCount > limits.maxTelemetrySeries) {
    throw new DelegatedExecutionLimitError("telemetrySeries", limits.maxTelemetrySeries)
  }
  if (input.limitPerSeries === undefined) {
    throw new Error(
      "[Sixb] Delegated telemetry history requires an explicit non-negative safe integer limit."
    )
  }
  if (!Number.isSafeInteger(input.limitPerSeries) || input.limitPerSeries < 0) {
    throw new Error("[Sixb] Delegated telemetry history limit must be a non-negative safe integer.")
  }

  const maximumPerSeries = Math.floor(limits.maxTelemetryPoints / Math.max(1, input.seriesCount))
  if (input.limitPerSeries > maximumPerSeries) {
    throw new DelegatedExecutionLimitError("telemetryPoints", limits.maxTelemetryPoints)
  }
  return input.limitPerSeries
}

/** Defend against a provider returning more points than the admitted delegated request. */
export function assertDelegatedTelemetryPointCount(
  pointCount: number,
  limits: Pick<DelegatedExecutionLimits, "maxTelemetryPoints">
): void {
  if (!Number.isSafeInteger(pointCount) || pointCount > limits.maxTelemetryPoints) {
    throw new DelegatedExecutionLimitError("telemetryPoints", limits.maxTelemetryPoints)
  }
}
