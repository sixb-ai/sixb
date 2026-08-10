import type { ReadonlyJsonValue, Schema, ValueType } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"

interface ProjectionSchemaErrorOptions {
  readonly code?: "internal.unexpected" | "projection.definition_invalid"
  readonly details?: Readonly<Record<string, ReadonlyJsonValue>>
}

export function resolveProjectionSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  options: ProjectionSchemaErrorOptions = {},
  seen = new Set<string>()
): Schema {
  if (typeof schema === "string") {
    return schema
  }

  if (schema.type !== "valueTypeRef") {
    return schema
  }

  const code = options.code ?? "internal.unexpected"
  const details = options.details ?? {}
  if (seen.has(schema.valueTypeId)) {
    throw createSixbError(
      code,
      `[SixbProjectionWorker] Circular valueTypeRef '${schema.valueTypeId}' in projection schema.`,
      { details: { ...details, valueTypeId: schema.valueTypeId } }
    )
  }

  const nextSeen = new Set(seen)
  nextSeen.add(schema.valueTypeId)

  if (schema._resolved) {
    return resolveProjectionSchema(schema._resolved, valueTypesById, options, nextSeen)
  }

  const valueType = valueTypesById.get(schema.valueTypeId)
  if (!valueType) {
    throw createSixbError(
      code,
      `[SixbProjectionWorker] Unknown valueTypeRef '${schema.valueTypeId}' in projection schema.`,
      { details: { ...details, valueTypeId: schema.valueTypeId } }
    )
  }

  return resolveProjectionSchema(valueType.schema, valueTypesById, options, nextSeen)
}

export function isIntegerEnumSchema(schema: Schema): boolean {
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "integer"
}
