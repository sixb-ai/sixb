import type { OntologyRegistry } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectType, ValueType } from "../ontology/types"
import { uniqueValueKey, uniqueValueKind } from "../ontology/unique-values"
import { normalizeSchemaValue, validateSchemaValue } from "../ontology/validation"

/**
 * The key a lookup by a unique property compares: the caller's value, validated and normalized as
 * a write would store it, so a `Date` finds the object a write gave the same date.
 */
export function uniqueLookupKey(
  ontology: OntologyRegistry,
  input: { readonly objectTypeId: string; readonly propertyId: string; readonly value: unknown }
): string {
  return uniqueLookupKeyOf(
    ontology.resolveObjectType(input.objectTypeId),
    input.propertyId,
    input.value,
    ontology.getValueTypesById()
  )
}

/** {@link uniqueLookupKey} against an already resolved object type. */
export function uniqueLookupKeyOf(
  objectType: ObjectType,
  propertyId: string,
  value: unknown,
  valueTypesById: ReadonlyMap<string, ValueType>
): string {
  const path = `${objectType.id}.${propertyId}`

  const property = objectType.properties.find((candidate) => candidate.id === propertyId)
  const kind = property?.unique ? uniqueValueKind(property.schema, valueTypesById) : undefined
  if (!property || !kind) {
    throw new OntologyValidationError(
      `[Sixb] Cannot look up '${path}' by value: getBy needs a property declared with unique: true.`
    )
  }

  if (value === null || value === undefined) {
    throw new OntologyValidationError(
      `[Sixb] Cannot look up '${path}' by ${String(value)}: no object holds a null or missing value.`
    )
  }

  validateSchemaValue(property.schema, value, path, valueTypesById)
  const key = uniqueValueKey(
    kind,
    normalizeSchemaValue(property.schema, value, path, valueTypesById)
  )
  if (key === null) {
    throw new OntologyValidationError(`[Sixb] Cannot look up '${path}' by this value.`)
  }
  return key
}
