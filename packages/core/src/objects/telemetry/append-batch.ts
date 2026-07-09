/**
 * Leaf operation: batch telemetry append for multiple objects of a single type.
 */
import { assertPrivileged } from "../../authorization"
import type { EventDraft } from "../../events"
import { OntologyValidationError } from "../../ontology/errors"
import {
  assertTelemetryProperty,
  validatePropertyValue,
  validateTelemetryUnit,
} from "../../ontology/validation"
import type { ResolvedObjectContext } from "../context"
import { requireObject } from "../helpers"
import { writeTelemetryBatch } from "./write-batch"

/**
 * Type guard for telemetry values that carry an explicit unit.
 *
 * Matches only the exact `{ value, unit }` wrapper (a string `unit` and no other
 * keys) so a legitimate JSON/object telemetry value is not silently
 * reinterpreted as value+unit. A fully explicit batch contract (passing units
 * out-of-band like the single-property appender) is tracked as a follow-up;
 * this narrows the heuristic without changing the public batch API.
 */
function isUnitBearingValue(raw: unknown): raw is { value: unknown; unit: string } {
  if (raw === null || typeof raw !== "object") {
    return false
  }
  const record = raw as Record<string, unknown>
  return "value" in record && typeof record.unit === "string" && Object.keys(record).length === 2
}

export async function appendTelemetryBatch(
  ctx: ResolvedObjectContext,
  items: readonly {
    id: string
    properties: Record<string, unknown | { value: unknown; unit: string }>
    at?: Date
  }[]
): Promise<void> {
  assertPrivileged(ctx, "appendTelemetry")
  const { storage, projectId, objectType, ontology } = ctx
  const checkedIds = new Set<string>()
  const events: EventDraft[] = []

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
