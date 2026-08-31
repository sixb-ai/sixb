import type { JsonObject, JsonValue } from "@sixb/core/models"

/** Return the original schema only when it satisfies strict Responses API object rules. */
export function gatewayOutputSchema(schema: JsonObject): JsonObject | undefined {
  return strictSchema(schema, true) ? schema : undefined
}

function strictSchema(schema: JsonObject, root = false): boolean {
  if (typeof schema.$ref === "string") return !root

  const objectSchema = schema.type === "object" || isObject(schema.properties)
  if (root && !objectSchema) return false
  if (objectSchema) {
    if (!isObject(schema.properties) || schema.additionalProperties !== false) return false
    const propertyNames = Object.keys(schema.properties)
    const required = Array.isArray(schema.required) ? schema.required : undefined
    if (!required || propertyNames.some((name) => !required.includes(name))) {
      return false
    }
    if (!Object.values(schema.properties).every(strictDefinition)) return false
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const definitions = schema[key]
    if (definitions !== undefined) {
      if (!Array.isArray(definitions) || !definitions.every(strictDefinition)) return false
    }
  }
  for (const key of ["definitions", "$defs"] as const) {
    const definitions = schema[key]
    if (definitions !== undefined) {
      if (!isObject(definitions) || !Object.values(definitions).every(strictDefinition))
        return false
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      if (!schema.items.every(strictDefinition)) return false
    } else if (!strictDefinition(schema.items)) {
      return false
    }
  }
  return true
}

function strictDefinition(value: JsonValue): boolean {
  return typeof value === "boolean" || (isObject(value) && strictSchema(value))
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
