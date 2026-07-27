/**
 * Leaf operation: batch telemetry append for multiple objects of a single type.
 */
import { assertPrivileged } from "../../authorization"
import type { TelemetryPointWrite } from "../../materialization/model"
import { telemetryPointKey } from "../../materialization/refs"
import { OntologyValidationError } from "../../ontology/errors"
import { assertTelemetryProperty } from "../../ontology/validation"
import type { ResolvedObjectContext } from "../context"
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
  const { objectType } = ctx
  // Telemetry identity is `(series, at)`, so a repeated instant inside one call is an upsert: the
  // last value wins rather than failing the whole batch.
  const points = new Map<string, TelemetryPointWrite>()

  for (const item of items) {
    const at = (item.at ?? new Date()).toISOString()

    for (const [propertyId, rawValue] of Object.entries(item.properties)) {
      const propertyToken = objectType.p[propertyId]
      if (!propertyToken) {
        throw new OntologyValidationError(`Unknown property '${objectType.id}.${propertyId}'`)
      }

      assertTelemetryProperty(propertyToken.property)

      // Value and unit validation, plus schema normalization, happen inside the Materializer.
      const series = {
        object: { objectTypeId: objectType.id, primaryId: item.id },
        propertyId: propertyToken.id,
      }
      points.set(telemetryPointKey(series, at), {
        series,
        value: isUnitBearingValue(rawValue)
          ? (rawValue.value as TelemetryPointWrite["value"])
          : (rawValue as TelemetryPointWrite["value"]),
        ...(isUnitBearingValue(rawValue) ? { unit: rawValue.unit } : {}),
        at,
      })
    }
  }

  await writeTelemetryBatch(ctx, [...points.values()])
}
