import type { Schema, ValueType } from "@sixb/core"
import { projectionWorkerError } from "./errors"

export function resolveProjectionSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seen = new Set<string>()
): Schema {
  if (typeof schema === "string") {
    return schema
  }

  if (schema.type !== "valueTypeRef") {
    return schema
  }

  if (seen.has(schema.valueTypeId)) {
    throw projectionWorkerError(
      `[SixbProjectionWorker] Circular valueTypeRef '${schema.valueTypeId}' in projection schema.`
    )
  }

  const nextSeen = new Set(seen)
  nextSeen.add(schema.valueTypeId)

  if (schema._resolved) {
    return resolveProjectionSchema(schema._resolved, valueTypesById, nextSeen)
  }

  const valueType = valueTypesById.get(schema.valueTypeId)
  if (!valueType) {
    throw projectionWorkerError(
      `[SixbProjectionWorker] Unknown valueTypeRef '${schema.valueTypeId}' in projection schema.`
    )
  }

  return resolveProjectionSchema(valueType.schema, valueTypesById, nextSeen)
}

export function isIntegerEnumSchema(schema: Schema): boolean {
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "integer"
}
