/**
 * Keys of unique property values.
 *
 * A property declared `unique: true` holds each value on at most one object of its exact type.
 * Storage compares the values through the keys computed here, so every provider matches them the
 * same way: strings exactly (case-sensitive, no trimming or Unicode normalization), integers by
 * their decimal form and user references by user id. `null` and absent values have no key: any
 * number of objects may hold them.
 */
import { primitiveTraits } from "./primitives"
import type { ObjectType, Schema, ValueType } from "./types"
import { isUserRef } from "./user-ref"

/** How the values of a unique property compare. */
export type UniqueValueKind = "string" | "integer" | "userRef"

/**
 * The version of the keys below. Storage records the version each property was prepared with:
 * changing how keys are computed means bumping it, which rebuilds every unique property.
 */
export const UNIQUE_VALUE_KEY_VERSION = 1

/** A unique property of an object type. */
export interface UniquePropertyDefinition {
  readonly propertyId: string
  readonly kind: UniqueValueKind
}

/**
 * The kind of a schema that can be unique, through value types: strings, uuids, dates, integers,
 * string and integer enums, and user references. `undefined` for every other schema.
 */
export function uniqueValueKind(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seenValueTypeIds: ReadonlySet<string> = new Set()
): UniqueValueKind | undefined {
  if (typeof schema === "string") return primitiveTraits(schema)?.unique

  if (schema.type === "enum") return schema.valueType === "integer" ? "integer" : "string"

  if (schema.type !== "valueTypeRef" || seenValueTypeIds.has(schema.valueTypeId)) {
    return undefined
  }

  const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
  if (!resolved) return undefined

  return uniqueValueKind(
    resolved,
    valueTypesById,
    new Set([...seenValueTypeIds, schema.valueTypeId])
  )
}

/** The unique properties of an object type, with how their values compare. */
export function uniquePropertiesOf(
  objectType: Pick<ObjectType, "properties">,
  valueTypesById: ReadonlyMap<string, ValueType>
): UniquePropertyDefinition[] {
  const unique: UniquePropertyDefinition[] = []
  for (const property of objectType.properties) {
    if (!property.unique) continue
    const kind = uniqueValueKind(property.schema, valueTypesById)
    if (kind) unique.push({ propertyId: property.id, kind })
  }
  return unique
}

/**
 * The key of a stored (validated and normalized) value, or `null` when the value claims nothing:
 * `null`, absent, or not of the kind.
 */
export function uniqueValueKey(kind: UniqueValueKind, value: unknown): string | null {
  switch (kind) {
    case "string":
      return typeof value === "string" ? value : null
    // Integers beyond 2^53 lose precision as JSON numbers, but each still has one decimal form.
    case "integer":
      return Number.isInteger(value) ? String(value) : null
    case "userRef":
      return isUserRef(value) ? value.id : null
  }
}
