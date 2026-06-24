import { type AuthorizationContext, assertAuthorized } from "../../authorization"
import type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesStorage,
} from "../../storage"

export interface TelemetryHistoryOptions {
  readonly storage: TimeseriesStorage
  readonly authorization?: AuthorizationContext | null
}

export async function getTelemetryHistoryBatch(
  input: TimeseriesHistoryBatchInput,
  options: TelemetryHistoryOptions
): Promise<readonly TimeseriesHistoryBatchResult[]> {
  assertTelemetrySeriesViewable(input.series, options.authorization)
  return options.storage.getHistoryBatch(input)
}

function assertTelemetrySeriesViewable(
  series: readonly TimeseriesHistorySeriesInput[],
  authorization: AuthorizationContext | null | undefined
): void {
  for (const objectTypeId of new Set(series.map((entry) => entry.objectTypeId))) {
    assertAuthorized(
      { authorization: authorization ?? undefined },
      { kind: "object.view", objectTypeId }
    )
  }
}
