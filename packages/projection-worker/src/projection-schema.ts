import type { Schema, ValueType } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"

type ProjectionSchemaErrorContext = Readonly<Record<string, string>>

export function resolveProjectionSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  errorContext: ProjectionSchemaErrorContext = {},
  seen = new Set<string>()
): Schema {
  if (typeof schema === "string") {
    return schema
  }

  if (schema.type !== "valueTypeRef") {
    return schema
  }

  if (seen.has(schema.valueTypeId)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbProjectionWorker] Circular valueTypeRef '${schema.valueTypeId}' in projection schema.`,
      { details: { ...errorContext, valueTypeId: schema.valueTypeId } }
    )
  }

  const nextSeen = new Set(seen)
  nextSeen.add(schema.valueTypeId)

  if (schema._resolved) {
    return resolveProjectionSchema(schema._resolved, valueTypesById, errorContext, nextSeen)
  }

  const valueType = valueTypesById.get(schema.valueTypeId)
  if (!valueType) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbProjectionWorker] Unknown valueTypeRef '${schema.valueTypeId}' in projection schema.`,
      { details: { ...errorContext, valueTypeId: schema.valueTypeId } }
    )
  }

  return resolveProjectionSchema(valueType.schema, valueTypesById, errorContext, nextSeen)
}

export function isIntegerEnumSchema(schema: Schema): boolean {
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "integer"
}
