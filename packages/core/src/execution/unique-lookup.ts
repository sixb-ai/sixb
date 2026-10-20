import type { OntologyRegistry } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import { uniqueValueKey } from "../ontology/unique-values"
import { normalizeSchemaValue, validateSchemaValue } from "../ontology/validation"

/**
 * The key a lookup by a unique property compares: the caller's value, validated and normalized as
 * a write would store it, so a `Date` finds the object a write gave the same date.
 */
export function uniqueLookupKey(
  ontology: OntologyRegistry,
  input: { readonly objectTypeId: string; readonly propertyId: string; readonly value: unknown }
): string {
  const { objectTypeId, propertyId, value } = input
  const path = `${objectTypeId}.${propertyId}`

  const unique = ontology
    .listUniqueProperties(objectTypeId)
    .find((candidate) => candidate.propertyId === propertyId)
  const property = ontology
    .resolveObjectType(objectTypeId)
    .properties.find((candidate) => candidate.id === propertyId)
  if (!unique || !property) {
    throw new OntologyValidationError(
      `[Sixb] Cannot look up '${path}' by value: getBy needs a property declared with unique: true.`
    )
  }

  if (value === null || value === undefined) {
    throw new OntologyValidationError(
      `[Sixb] Cannot look up '${path}' by ${String(value)}: no object holds a null or missing value.`
    )
  }

  const valueTypesById = ontology.getValueTypesById()
  validateSchemaValue(property.schema, value, path, valueTypesById)
  const key = uniqueValueKey(
    unique.kind,
    normalizeSchemaValue(property.schema, value, path, valueTypesById)
  )
  if (key === null) {
    throw new OntologyValidationError(`[Sixb] Cannot look up '${path}' by this value.`)
  }
  return key
}
