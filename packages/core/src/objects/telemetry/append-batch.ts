/**
 * Leaf operation: batch telemetry append for multiple objects of a single type.
 */
import type { NewDomainEvent } from "../../events"
import { OntologyValidationError } from "../../ontology/errors"
import {
  assertTelemetryProperty,
  validatePropertyValue,
  validateTelemetryUnit,
} from "../../ontology/validation"
import type { ResolvedObjectContext } from "../context"
import { requireObject } from "../helpers"
import { writeTelemetryBatch } from "./write-batch"

/** Type guard for telemetry values that carry an explicit unit. */
function isUnitBearingValue(raw: unknown): raw is { value: unknown; unit: string } {
  return raw !== null && typeof raw === "object" && "value" in raw && "unit" in raw
}

export async function appendTelemetryBatch(
  ctx: ResolvedObjectContext,
  items: readonly {
    id: string
    properties: Record<string, unknown | { value: unknown; unit: string }>
    at?: Date
  }[]
): Promise<void> {
  const { storage, projectId, objectType, ontology } = ctx
  const checkedIds = new Set<string>()
  const events: NewDomainEvent[] = []

  for (const item of items) {
    const at = (item.at ?? new Date()).toISOString()

    if (!checkedIds.has(item.id)) {
      await requireObject(
        storage,
        projectId,
        objectType.id,
        item.id,
        "Object not found for telemetry append"
      )
      checkedIds.add(item.id)
    }

    for (const [propertyId, rawValue] of Object.entries(item.properties)) {
      const propertyToken = objectType.p[propertyId]
      if (!propertyToken) {
        throw new OntologyValidationError(`Unknown property '${objectType.id}.${propertyId}'`)
      }

      assertTelemetryProperty(propertyToken.property)

      const value = isUnitBearingValue(rawValue) ? rawValue.value : rawValue
      const unit = isUnitBearingValue(rawValue) ? rawValue.unit : undefined

      const propertyPath = `${objectType.id}.${propertyToken.id}`

      validatePropertyValue(
        propertyToken.property,
        value,
        propertyPath,
        ontology.getValueTypesById()
      )
      validateTelemetryUnit(
        propertyToken.property,
        propertyPath,
        unit,
        ontology.getValueTypesById()
      )

      events.push({
        type: "telemetry.appended",
        payload: {
          objectTypeId: objectType.id,
          objectId: item.id,
          propertyId: propertyToken.id,
          value,
          ...(unit !== undefined ? { unit } : {}),
          at,
        },
      })
    }
  }

  if (events.length > 0) {
    await writeTelemetryBatch(ctx, events)
  }
}
