import type { Property, ValueType } from ".."
import { OntologyValidationError } from "../errors"
import type { QuantitativeTypeId } from "../units"
import { isValidUnit } from "../units"
import { resolveValueTypeRef } from "./schema"

export function assertTelemetryProperty(property: Property): void {
  if (property.mode !== "telemetry") {
    throw new OntologyValidationError(`[Sixb] Property ${property.id} is not telemetry-enabled`)
  }
}

export function resolveSemanticType(
  property: Property,
  valueTypesById: ReadonlyMap<string, ValueType>
): QuantitativeTypeId | undefined {
  if (property.semanticType) {
    return property.semanticType
  }

  const valueTypeId = resolveValueTypeRef(property.schema)
  if (!valueTypeId) {
    return undefined
  }

  return valueTypesById.get(valueTypeId)?.semanticType
}

/** Validates that unit is present/absent based on semantic type, and that it's a valid unit. */
export function validateTelemetryUnit(
  property: Property,
  propertyPath: string,
  unit: string | undefined,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  const semanticType = resolveSemanticType(property, valueTypesById)
  if (semanticType) {
    if (!unit) {
      throw new OntologyValidationError(
        `[Sixb] Missing unit for telemetry property ${propertyPath}`
      )
    }
    if (!isValidUnit(semanticType, unit)) {
      throw new OntologyValidationError(
        `[Sixb] Invalid unit '${unit}' for ${propertyPath} (${semanticType})`
      )
    }
  } else if (unit) {
    throw new OntologyValidationError(
      `[Sixb] Property ${propertyPath} does not define semanticType and cannot accept a unit`
    )
  }
}
