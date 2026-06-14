import { assertJsonValue, cloneJsonValue, type JsonValue } from "../../json"
import type { ObjectFieldSchema, Schema, ValueType } from ".."
import { OntologyValidationError } from "../errors"

export function normalizeSchemaValue(
  schema: Schema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue {
  if (typeof schema === "string") {
    switch (schema) {
      case "date":
        return normalizeDateValue(value, path)
      case "timestamp":
        return normalizeTimestampValue(value, path)
      default:
        assertJsonValue(value, path)
        return cloneJsonValue(value)
    }
  }

  if (schema.type === "valueTypeRef") {
    const valueType = valueTypesById.get(schema.valueTypeId)
    if (!valueType) {
      throw new OntologyValidationError(
        `[Sixb] Unknown valueTypeRef '${schema.valueTypeId}' at ${path}`
      )
    }
    return normalizeSchemaValue(valueType.schema, value, path, valueTypesById)
  }

  if (schema.type === "enum") {
    assertJsonValue(value, path)
    return cloneJsonValue(value)
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new OntologyValidationError(`[Sixb] Property ${path} must be an array`)
    }
    return (value as readonly unknown[]).map((entry, index) =>
      normalizeSchemaValue(schema.items, entry, `${path}[${index}]`, valueTypesById)
    )
  }

  if (schema.type === "map") {
    const record = assertPlainRecord(value, path)
    const entries = Object.entries(record).map(([key, entry]) => [
      key,
      normalizeSchemaValue(schema.valueSchema, entry, `${path}.${key}`, valueTypesById),
    ])
    return Object.fromEntries(entries)
  }

  const fields = schema.properties
  const record = assertPlainRecord(value, path)
  const output: Record<string, JsonValue> = {}
  for (const [fieldId, field] of Object.entries(fields)) {
    const fieldValue = record[fieldId]
    if (fieldValue === undefined) {
      continue
    }
    output[fieldId] = normalizeObjectFieldValue(
      field,
      fieldValue,
      `${path}.${fieldId}`,
      valueTypesById
    )
  }
  return output
}

function normalizeObjectFieldValue(
  field: ObjectFieldSchema,
  value: unknown,
  path: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): JsonValue {
  if (value === null) {
    return null
  }

  return normalizeSchemaValue(field.schema, value, path, valueTypesById)
}

function assertPlainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function normalizeDateValue(value: unknown, path: string): string {
  const date = normalizeDateLike(value, path)
  return date.toISOString().slice(0, 10)
}

function normalizeTimestampValue(value: unknown, path: string): string {
  return normalizeDateLike(value, path).toISOString()
}

function normalizeDateLike(value: unknown, path: string): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be a valid date`)
  }
  return date
}
