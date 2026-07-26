/**
 * Telemetry appender factory for ObjectByIdHandle.
 *
 * Creates a per-property telemetry appender that validates values and units
 * before writing telemetry events via the low-level writeTelemetryBatch leaf.
 */
import type { TelemetryPointWrite } from "../../materialization/model"
import type { ValueType } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import {
  assertPropertyTokenBelongsToObjectType,
  assertTelemetryProperty,
} from "../../ontology/validation"
import type { TelemetryAppender, TelemetryPropertyToken } from "../../runtime/types"
import type { ResolvedObjectContext } from "../context"
import { writeTelemetryBatch } from "../telemetry"

export function createTelemetryAppender<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(ctx: ResolvedObjectContext, primaryId: string) {
  return <TToken extends TelemetryPropertyToken<TObjectType>>(
    property: TToken
  ): TelemetryAppender<TToken, TValueTypes> => {
    const { objectType } = ctx
    assertPropertyTokenBelongsToObjectType(objectType, property)
    assertTelemetryProperty(property.property)

    const appender = {
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
    }

    // Cast needed: generic token inference boundary — TToken is narrower than what `appender` sees
    return appender as unknown as TelemetryAppender<TToken, TValueTypes>
  }
}
