/**
 * Telemetry channel factory for ObjectByIdHandle.
 *
 * Creates a per-property channel that writes through the low-level `writeTelemetryBatch` leaf and
 * reads the same series back through `getTelemetryHistoryBatch`, both keyed by the property token.
 */
import type { TelemetryPointWrite } from "../../materialization/model"
import type { ValueType } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import {
  assertPropertyTokenBelongsToObjectType,
  assertTelemetryProperty,
} from "../../ontology/validation"
import { RuntimeError } from "../../runtime/errors"
import type {
  TelemetryChannel,
  TelemetryHistoryInput,
  TelemetryPropertyToken,
} from "../../runtime/types"
import type { ResolvedObjectContext } from "../context"
import { getTelemetryHistoryBatch, writeTelemetryBatch } from "../telemetry"

export function createTelemetryChannel<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(ctx: ResolvedObjectContext, primaryId: string) {
  return <TToken extends TelemetryPropertyToken<TObjectType>>(
    property: TToken
  ): TelemetryChannel<TToken, TValueTypes> => {
    const { objectType } = ctx
    assertPropertyTokenBelongsToObjectType(objectType, property)
    assertTelemetryProperty(property.property)

    const series = { objectTypeId: objectType.id, objectId: primaryId, propertyId: property.id }

    const channel = {
      append: async (input: { value: unknown; unit?: string; at: Date }) => {
        // Value and unit validation, plus schema normalization, happen inside the Materializer.
        await writeTelemetryBatch(ctx, [
          {
            series: {
              object: { objectTypeId: objectType.id, primaryId },
              propertyId: property.id,
            },
            value: input.value as TelemetryPointWrite["value"],
            ...(input.unit !== undefined ? { unit: input.unit } : {}),
            at: input.at.toISOString(),
          },
        ])
      },

      history: async (input: TelemetryHistoryInput = {}) => {
        const timeseries = ctx.storage.timeseries
        const objectReader = ctx.objectReader
        if (!timeseries) {
          throw new RuntimeError("[Sixb] Reading telemetry requires storage.timeseries support.")
        }

        const from = input.from
        const to = input.to
        const limit = input.limit
        const order = input.order

        const [result] = await getTelemetryHistoryBatch(
          {
            series: [series],
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
            ...(limit !== undefined ? { limitPerSeries: limit } : {}),
            ...(order !== undefined ? { order } : {}),
          },
          {
            storage: timeseries,
            objectReader,
          }
        )

        return (result?.points ?? []).map((point) => ({
          value: point.value,
          at: point.at,
          ...(point.unit !== undefined ? { unit: point.unit } : {}),
        }))
      },
    }

    // Cast needed: generic token inference boundary — TToken is narrower than what `channel` sees
    return channel as unknown as TelemetryChannel<TToken, TValueTypes>
  }
}
