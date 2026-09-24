import { withFailureMessage } from "../../errors/failure-message"
import type { ObjectLink, ObjectType, PrimitiveSchema, Property, Schema, ValueType } from ".."
import { OntologyValidationError } from "../errors"
import { primitiveTraits } from "../primitives"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../tokens"
import { validateSchemaValue } from "./schema"

export function assertObjectTypeRegistered(
  objectTypesById: ReadonlyMap<string, ObjectTypeWithPropertyTokens>,
  objectType: ObjectTypeWithPropertyTokens
): void {
  if (!objectTypesById.has(objectType.id)) {
    throw new OntologyValidationError(
      `[Sixb] Object type is not registered in this runtime: ${objectType.id}`
    )
  }
}

export function assertPropertyTokenBelongsToObjectType(
  objectType: ObjectTypeWithPropertyTokens,
  property: PropertyToken<string, string, Property>
): void {
  if (property.objectTypeId !== objectType.id) {
    throw new OntologyValidationError(
      `[Sixb] Property token ${property.objectTypeId}.${property.id} cannot be used with ${objectType.id}`
    )
  }
}

export function assertLinkTokenBelongsToObjectType(
  objectType: ObjectTypeWithPropertyTokens,
  link: unknown
): asserts link is LinkToken<string, string, string | readonly string[], ObjectLink> {
  if (!isLinkTokenLike(link)) {
    throw new OntologyValidationError(
      `[Sixb] Expected a link token from ${objectType.id}.l.<linkId>, not a plain link id.`
    )
  }

  if (link.objectTypeId !== objectType.id) {
    throw new OntologyValidationError(
      `[Sixb] Link token ${link.objectTypeId}.${link.id} cannot be used with ${objectType.id}`
    )
  }
}

function isLinkTokenLike(
  value: unknown
): value is LinkToken<string, string, string | readonly string[], ObjectLink> {
  if (typeof value !== "object" || value === null) return false
  if (
    !("objectTypeId" in value) ||
    !("id" in value) ||
    !("targetObjectTypeId" in value) ||
    !("link" in value)
  ) {
    return false
  }

  return (
    typeof value.objectTypeId === "string" &&
    typeof value.id === "string" &&
    isLinkTargetTypeId(value.targetObjectTypeId) &&
    typeof value.link === "object" &&
    value.link !== null
  )
}

function isLinkTargetTypeId(value: unknown): value is string | readonly string[] {
  return typeof value === "string" || (Array.isArray(value) && value.every(isString))
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

export function assertKnownProperties(
  objectType: ObjectTypeWithPropertyTokens,
  properties: Record<string, unknown>
): void {
  const knownIds = new Set(objectType.properties.map((property) => property.id))
  for (const propertyId of Object.keys(properties)) {
    if (!knownIds.has(propertyId)) {
      throw new OntologyValidationError(
        `[Sixb] Unknown property '${propertyId}' for object type '${objectType.id}'`
      )
    }
  }
}

export function assertRequiredProperties(
  objectType: ObjectTypeWithPropertyTokens,
  properties: Record<string, unknown>
): void {
  for (const property of objectType.properties) {
    if (property.required && properties[property.id] === undefined) {
      throw withFailureMessage(
        new OntologyValidationError(
          `[Sixb] Missing required property '${property.id}' for object type '${objectType.id}'`
        ),
        `Missing required property '${objectType.id}.${property.id}'.`
      )
    }
  }
}

/** Runtime validation protects callers even when TypeScript checks are bypassed. */
export function validateObjectProperties(
  objectType: ObjectTypeWithPropertyTokens,
  properties: Record<string, unknown>,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  for (const [propertyId, value] of Object.entries(properties)) {
    const property = objectType.properties.find((candidate) => candidate.id === propertyId)
    if (!property) {
      continue
    }
    validatePropertyValue(property, value, `${objectType.id}.${propertyId}`, valueTypesById)
  }
}

/**
 * Validate that every registered object type has exactly one primary property
 * that is required and has schema "string".
 *
 * Returns a Map<objectTypeId, primaryPropertyId> for runtime derivation.
 */
export function validatePrimaryProperties(
  objectTypesById: ReadonlyMap<string, ObjectType>
): Map<string, string> {
  const result = new Map<string, string>()

  for (const [typeId, objectType] of objectTypesById) {
    const primaries = objectType.properties.filter((p) => p.primary)

    if (primaries.length === 0) {
      throw new OntologyValidationError(
        `[Sixb] Object type '${typeId}' has no primary property. ` +
          `Define one with prop("id", "string", { required: true, primary: true }).`
      )
    }
    if (primaries.length > 1) {
      throw new OntologyValidationError(
        `[Sixb] Object type '${typeId}' has ${primaries.length} primary properties, expected 1`
      )
    }

    const primary = primaries[0]
    if (!primary.required) {
      throw new OntologyValidationError(
        `[Sixb] Primary property '${primary.id}' on '${typeId}' must be required`
      )
    }
    if (primary.schema !== "string") {
      throw new OntologyValidationError(
        `[Sixb] Primary property '${primary.id}' on '${typeId}' must have schema "string", got "${String(primary.schema)}"`
      )
    }

    result.set(typeId, primary.id)
  }

  return result
}

export function validatePropertyDefinitions(
  objectTypesById: ReadonlyMap<string, ObjectType>,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  for (const [typeId, objectType] of objectTypesById) {
    for (const property of objectType.properties) {
      if (property.mode !== "telemetry") continue
      // Telemetry stores time-series samples, not references, even when the reference is nested.
      const primitive = findNonTelemetryPrimitive(property.schema, valueTypesById)
      if (primitive) {
        throw new OntologyValidationError(
          `[Sixb] Telemetry property '${property.id}' on '${typeId}' cannot use ${primitive}`
        )
      }
    }
  }
}

export function validatePropertyValue(
  property: Property,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  if (value === undefined) {
    throw withFailureMessage(
      new OntologyValidationError(`[Sixb] Property ${path} cannot be undefined`),
      `Property ${path} cannot be undefined.`
    )
  }

  if (value === null) {
    if (property.nullable) {
      return
    }
    throw withFailureMessage(
      new OntologyValidationError(`[Sixb] Property ${path} cannot be null`),
      `Property ${path} cannot be null.`
    )
  }

  validateSchemaValue(property.schema, value, path, valueTypesById)
}

function findNonTelemetryPrimitive(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seenValueTypeIds = new Set<string>()
): PrimitiveSchema | undefined {
  if (typeof schema === "string") {
    return primitiveTraits(schema)?.telemetry === false ? schema : undefined
  }

  if (schema.type === "array") {
    return findNonTelemetryPrimitive(schema.items, valueTypesById, seenValueTypeIds)
  }

  if (schema.type === "map") {
    return findNonTelemetryPrimitive(schema.valueSchema, valueTypesById, seenValueTypeIds)
  }

  if (schema.type === "object") {
    for (const field of Object.values(schema.properties)) {
      const primitive = findNonTelemetryPrimitive(field.schema, valueTypesById, seenValueTypeIds)
      if (primitive) return primitive
    }
    return undefined
  }

  if (schema.type === "valueTypeRef") {
    if (seenValueTypeIds.has(schema.valueTypeId)) {
      return undefined
    }

    seenValueTypeIds.add(schema.valueTypeId)
    const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
    return resolved
      ? findNonTelemetryPrimitive(resolved, valueTypesById, seenValueTypeIds)
      : undefined
  }

  return undefined
}
