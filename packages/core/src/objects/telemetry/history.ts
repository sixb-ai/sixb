import { type AuthorizationContext, assertAuthorized } from "../../authorization"
import type { RuntimeAuthorization } from "../../execution"
import type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesStorage,
} from "../../storage"

export interface TelemetryHistoryOptions {
  readonly storage: TimeseriesStorage
  readonly runtimeAuthorization?: RuntimeAuthorization
  readonly authorization?: AuthorizationContext | null
}

export async function getTelemetryHistoryBatch(
  input: TimeseriesHistoryBatchInput,
  options: TelemetryHistoryOptions
): Promise<readonly TimeseriesHistoryBatchResult[]> {
  assertTelemetrySeriesViewable(input.projectId, input.series, options)
  return options.storage.getHistoryBatch(input)
}

function assertTelemetrySeriesViewable(
  projectId: string,
  series: readonly TimeseriesHistorySeriesInput[],
  authorization: Pick<TelemetryHistoryOptions, "authorization" | "runtimeAuthorization">
): void {
  for (const objectTypeId of new Set(series.map((entry) => entry.objectTypeId))) {
    assertAuthorized(
      {
        projectId,
        runtimeAuthorization: authorization.runtimeAuthorization,
        authorization: authorization.authorization ?? undefined,
      },
      { kind: "object.view", objectTypeId }
    )
  }
}
