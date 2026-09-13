import { isPlainRecord } from "../../json"

const PRIMITIVE_SCHEMAS = new Set([
  "string",
  "integer",
  "double",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "uuid",
  "fileRef",
])

/** Validate a declarative schema's shape independently of the primitive that consumes it. */
export function assertValidSchema(
  schema: unknown,
  path: string,
  invalid: (path: string) => Error,
  visiting: Set<object> = new Set()
): void {
  if (typeof schema === "string") {
    if (PRIMITIVE_SCHEMAS.has(schema)) {
      return
    }
    throw invalid(path)
  }
  if (!isPlainRecord(schema) || typeof schema.type !== "string" || visiting.has(schema)) {
    throw invalid(path)
  }

  visiting.add(schema)
  switch (schema.type) {
    case "enum": {
      const values = schema.values
      const validValues = isValidEnumValues(values, schema.valueType)
      if (!validValues || new Set(values).size !== values.length) {
        throw invalid(path)
      }
      break
    }
    case "array":
      assertValidSchema(schema.items, `${path}.items`, invalid, visiting)
      break
    case "map":
      if (schema.keySchema !== "string") {
        throw invalid(path)
      }
      assertValidSchema(schema.valueSchema, `${path}.valueSchema`, invalid, visiting)
      break
    case "object": {
      if (!isPlainRecord(schema.properties)) {
        throw invalid(path)
      }
      for (const [fieldId, field] of Object.entries(schema.properties)) {
        if (!fieldId.trim() || !isPlainRecord(field) || !("schema" in field)) {
          throw invalid(`${path}.properties.${fieldId}`)
        }
        if (
          (field.required !== undefined && typeof field.required !== "boolean") ||
          (field.nullable !== undefined && typeof field.nullable !== "boolean") ||
          (field.description !== undefined &&
            (typeof field.description !== "string" || !field.description.trim()))
        ) {
          throw invalid(`${path}.properties.${fieldId}`)
        }
        assertValidSchema(field.schema, `${path}.properties.${fieldId}.schema`, invalid, visiting)
      }
      break
    }
    case "valueTypeRef":
      if (typeof schema.valueTypeId !== "string" || !schema.valueTypeId.trim()) {
        throw invalid(path)
      }
      if (schema._resolved !== undefined) {
        assertValidSchema(schema._resolved, `${path}._resolved`, invalid, visiting)
      }
      break
    default:
      throw invalid(path)
  }
  visiting.delete(schema)
}

function isValidEnumValues(values: unknown, valueType: unknown): values is unknown[] {
  if (!Array.isArray(values) || values.length === 0) {
    return false
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      return false
    }
    const value = values[index]
    if (
      valueType === "string"
        ? typeof value !== "string"
        : valueType !== "integer" || typeof value !== "number" || !Number.isInteger(value)
    ) {
      return false
    }
  }
  return true
}
