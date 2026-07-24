/**
 * Telemetry appender factory for ObjectByIdHandle.
 *
 * Creates a per-property telemetry appender that validates values and units
 * before writing telemetry events via the low-level writeTelemetryBatch leaf.
 */
import type { ValueType } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import {
  assertPropertyTokenBelongsToObjectType,
  assertTelemetryProperty,
  normalizeSchemaValue,
  validatePropertyValue,
  validateTelemetryUnit,
} from "../../ontology/validation"
import type { TelemetryAppender, TelemetryPropertyToken } from "../../runtime/types"
import { ObjectNotFoundError } from "../../storage/errors"
import type { ResolvedObjectContext } from "../context"
import { writeTelemetryBatch } from "../telemetry"

export function createTelemetryAppender<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(ctx: ResolvedObjectContext, primaryId: string) {
  return <TToken extends TelemetryPropertyToken<TObjectType>>(
    property: TToken
  ): TelemetryAppender<TToken, TValueTypes> => {
    const { objectType, storage, projectId, ontology } = ctx
    assertPropertyTokenBelongsToObjectType(objectType, property)
    assertTelemetryProperty(property.property)

    const telemetryProperty = property.property

    const appender = {
      append: async (input: { value: unknown; unit?: string; at: Date }) => {
        const object = await storage.objects.getByPrimaryId({
          projectId: projectId,
          objectTypeId: objectType.id,
          primaryId,
        })

        if (!object) {
          throw new ObjectNotFoundError(
            objectType.id,
            primaryId,
            "Object not found for telemetry append"
          )
        }

        const propertyPath = `${objectType.id}.${property.id}`

        validatePropertyValue(
          telemetryProperty,
          input.value,
          propertyPath,
          ontology.getValueTypesById()
        )
        validateTelemetryUnit(
          telemetryProperty,
          propertyPath,
          input.unit,
          ontology.getValueTypesById()
        )

        const normalizedValue = normalizeSchemaValue(
          telemetryProperty.schema,
          input.value,
          propertyPath,
          ontology.getValueTypesById()
        )

        await writeTelemetryBatch(ctx, [
          {
            type: "telemetry.appended",
            payload: {
              objectTypeId: ctx.objectType.id,
              objectId: primaryId,
              propertyId: property.id,
              value: normalizedValue,
              ...(input.unit !== undefined ? { unit: input.unit } : {}),
              at: input.at.toISOString(),
            },
          },
        ])
      },
    }

    // Cast needed: generic token inference boundary — TToken is narrower than what `appender` sees
    return appender as unknown as TelemetryAppender<TToken, TValueTypes>
  }
}
