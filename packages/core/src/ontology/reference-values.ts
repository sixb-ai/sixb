import type { PrimitiveSchema, Schema, ValueType } from "./types"

/**
 * Visit each value a schema holds at positions of one primitive, however deeply nested: array
 * items, map values, object fields, and through value types.
 *
 * Positions whose value does not match the schema are skipped: shape validation reports them. A
 * value type that refers to itself is followed once.
 */
export function visitPrimitiveValues(
  schema: Schema,
  primitive: PrimitiveSchema,
  value: unknown,
  valueTypesById: ReadonlyMap<string, ValueType>,
  visit: (value: unknown) => void,
  seenValueTypeIds: ReadonlySet<string> = new Set()
): void {
  if (value === null || value === undefined) return

  if (typeof schema === "string") {
    if (schema === primitive) visit(value)
    return
  }

  const visitBelow = (below: Schema, belowValue: unknown, seen = seenValueTypeIds) =>
    visitPrimitiveValues(below, primitive, belowValue, valueTypesById, visit, seen)

  switch (schema.type) {
    case "array":
      if (Array.isArray(value)) {
        for (const item of value) visitBelow(schema.items, item)
      }
      return
    case "map":
      if (isRecord(value)) {
        for (const item of Object.values(value)) visitBelow(schema.valueSchema, item)
      }
      return
    case "object":
      if (isRecord(value)) {
        for (const [fieldId, field] of Object.entries(schema.properties)) {
          visitBelow(field.schema, value[fieldId])
        }
      }
      return
    case "valueTypeRef": {
      if (seenValueTypeIds.has(schema.valueTypeId)) return

      const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
      if (!resolved) return

      visitBelow(resolved, value, new Set([...seenValueTypeIds, schema.valueTypeId]))
      return
    }
    case "enum":
      return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
