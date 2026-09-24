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
      assertNoObjectRefSchema(property, `Property '${typeId}.${property.id}'`, valueTypesById)
      if (property.mode !== "telemetry") continue
      // Telemetry stores time-series samples, not references, even when the reference is nested.
      const primitive = findPrimitiveSchema(
        property.schema,
        valueTypesById,
        (schema) => primitiveTraits(schema)?.telemetry === false
      )
      if (primitive) {
        throw new OntologyValidationError(
          `[Sixb] Telemetry property '${property.id}' on '${typeId}' cannot use ${primitive}`
        )
      }
    }
    for (const link of objectType.links) {
      for (const property of link.properties ?? []) {
        const path = `Link property '${typeId}.${link.id}.${property.id}'`
        assertNoObjectRefSchema(property, path, valueTypesById)
        // Link edits do not check that referenced users exist and are active.
        if (
          findPrimitiveSchema(property.schema, valueTypesById, (schema) => schema === "userRef")
        ) {
          throw new OntologyValidationError(
            `[Sixb] ${path} cannot use ref.user(). User references are supported on object properties only.`
          )
        }
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

/**
 * First primitive anywhere inside `schema`, through arrays, maps, object fields, and value types,
 * that `matches` accepts.
 */
export function findPrimitiveSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  matches: (schema: PrimitiveSchema) => boolean,
  seenValueTypeIds = new Set<string>()
): PrimitiveSchema | undefined {
  if (typeof schema === "string") {
    return matches(schema) ? schema : undefined
  }

  if (schema.type === "array") {
    return findPrimitiveSchema(schema.items, valueTypesById, matches, seenValueTypeIds)
  }

  if (schema.type === "map") {
    return findPrimitiveSchema(schema.valueSchema, valueTypesById, matches, seenValueTypeIds)
  }

  if (schema.type === "object") {
    for (const field of Object.values(schema.properties)) {
      const primitive = findPrimitiveSchema(field.schema, valueTypesById, matches, seenValueTypeIds)
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
      ? findPrimitiveSchema(resolved, valueTypesById, matches, seenValueTypeIds)
      : undefined
  }

  return undefined
}

/**
 * `ref(ObjectType)` is a parameter schema. Untyped definitions can still pass it to `prop()`,
 * where it would be stored as an opaque record instead of a traversable relationship.
 */
function assertNoObjectRefSchema(
  property: Property,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  if (!containsObjectRefSchema(property.schema, valueTypesById)) return
  throw new OntologyValidationError(
    `[Sixb] ${path} uses ref(ObjectType), which is only for Action and Workflow parameters. Point to another object with link("${property.id}", ObjectType) instead.`
  )
}

function containsObjectRefSchema(
  schema: unknown,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seen = new Set<unknown>()
): boolean {
  if (typeof schema !== "object" || schema === null || seen.has(schema)) return false
  seen.add(schema)
  const node = schema as Record<string, unknown>
  switch (node.type) {
    case "objectRef":
      return true
    case "array":
      return containsObjectRefSchema(node.items, valueTypesById, seen)
    case "map":
      return containsObjectRefSchema(node.valueSchema, valueTypesById, seen)
    case "object":
      return (
        typeof node.properties === "object" &&
        node.properties !== null &&
        Object.values(node.properties).some((field) =>
          containsObjectRefSchema((field as { schema?: unknown })?.schema, valueTypesById, seen)
        )
      )
    case "valueTypeRef":
      return containsObjectRefSchema(
        node._resolved ?? valueTypesById.get(String(node.valueTypeId))?.schema,
        valueTypesById,
        seen
      )
    default:
      return false
  }
}
