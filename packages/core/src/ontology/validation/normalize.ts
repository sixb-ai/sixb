import { assertJsonValue, cloneJsonValue, type JsonValue } from "../../json"
import type { ObjectFieldSchema, Property, Schema, ValueType } from ".."
import { normalizeDecimalValue } from "../decimal"
import { OntologyValidationError } from "../errors"
import { isRecord, resolveValueTypeSchema } from "./schema"

/**
 * Normalize a property bag to JSON-safe values using each property's schema —
 * notably converting `Date` to an ISO string for `date`/`timestamp` props.
 * Unknown properties are skipped; `null` passes through unchanged.
 *
 * Shared by the object upsert and edit paths so both emit the same serializable
 * shape; the typed surface accepts `Date | string`, the wire stores strings.
 */
export function normalizeObjectProperties(
  definitions: readonly Property[],
  properties: Readonly<Record<string, unknown>>,
  valueTypesById: ReadonlyMap<string, ValueType>,
  path: string
): Record<string, JsonValue> {
  const normalized: Record<string, JsonValue> = {}
  for (const [propertyId, value] of Object.entries(properties)) {
    const property = definitions.find((candidate) => candidate.id === propertyId)
    if (!property) continue
    normalized[propertyId] =
      value === null
        ? null
        : normalizeSchemaValue(property.schema, value, `${path}.${propertyId}`, valueTypesById)
  }
  return normalized
}

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
      case "decimal":
        return normalizeDecimal(value, path)
      default:
        assertJsonValue(value, path)
        return cloneJsonValue(value)
    }
  }

  if (schema.type === "valueTypeRef") {
    return normalizeSchemaValue(
      resolveValueTypeSchema(schema, valueTypesById, path),
      value,
      path,
      valueTypesById
    )
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

function normalizeDecimal(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be an exact decimal string`)
  }

  try {
    return normalizeDecimalValue(value)
  } catch {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be an exact decimal string`)
  }
}

function normalizeDateLike(value: unknown, path: string): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw new OntologyValidationError(`[Sixb] Property ${path} must be a valid date`)
  }
  return date
}

/**
 * Inverse of `normalizeSchemaValue` for the handler-facing surface: re-hydrate
 * `date`/`timestamp` values from their stored ISO string back into a `Date`, so
 * a handler receives the `Date` its types promise. Other scalars pass through;
 * arrays, maps, objects, and value-type refs recurse. The input is assumed to be
 * already validated/normalized JSON, so this is permissive and never throws.
 */
export function coerceSchemaValueToTyped(
  schema: Schema,
  value: unknown,
  valueTypesById: ReadonlyMap<string, ValueType>
): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof schema === "string") {
    if (schema === "date" || schema === "timestamp") {
      return value instanceof Date ? value : new Date(String(value))
    }
    return value
  }

  if (schema.type === "valueTypeRef") {
    return coerceSchemaValueToTyped(
      resolveValueTypeSchema(schema, valueTypesById, ""),
      value,
      valueTypesById
    )
  }

  if (schema.type === "enum") {
    return value
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return value
    return (value as readonly unknown[]).map((entry) =>
      coerceSchemaValueToTyped(schema.items, entry, valueTypesById)
    )
  }

  if (schema.type === "map") {
    if (!isRecord(value)) return value
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        coerceSchemaValueToTyped(schema.valueSchema, entry, valueTypesById),
      ])
    )
  }

  if (!isRecord(value)) return value
  const output: Record<string, unknown> = { ...value }
  for (const [fieldId, field] of Object.entries(schema.properties)) {
    if (value[fieldId] === undefined) continue
    output[fieldId] = coerceSchemaValueToTyped(field.schema, value[fieldId], valueTypesById)
  }
  return output
}
