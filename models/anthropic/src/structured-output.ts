import type { JsonObject, JsonValue } from "@sixb/core/models"

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
])

const DESCRIPTION_CONSTRAINTS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "not",
] as const

/** Return an Anthropic-compatible decoder schema, or undefined when tool fallback is safer. */
export function anthropicOutputSchema(schema: JsonObject): JsonObject | undefined {
  return sanitizeSchema(schema)
}

function sanitizeSchema(schema: JsonObject): JsonObject | undefined {
  if (typeof schema.$ref === "string") return { $ref: schema.$ref }

  const objectSchema = schema.type === "object" || isObject(schema.properties)
  // Anthropic requires closed objects. Narrowing an open object would change the contract, so let
  // the JSON tool enforce that schema instead of silently rewriting it.
  if (objectSchema && schema.additionalProperties !== false) {
    return undefined
  }

  const result: JsonObject = {}
  for (const key of ["$schema", "$id", "title", "description"] as const) {
    if (typeof schema[key] === "string") result[key] = schema[key]
  }
  for (const key of ["default", "const", "enum", "type"] as const) {
    if (schema[key] !== undefined) result[key] = schema[key]
  }

  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined
  if (union) {
    const sanitized = sanitizeDefinitions(union)
    if (!sanitized) return undefined
    result.anyOf = sanitized
  }
  if (Array.isArray(schema.allOf)) {
    const sanitized = sanitizeDefinitions(schema.allOf)
    if (!sanitized) return undefined
    result.allOf = sanitized
  }

  for (const key of ["definitions", "$defs"] as const) {
    const definitions = schema[key]
    if (!isObject(definitions)) continue
    const sanitized = sanitizeRecord(definitions)
    if (!sanitized) return undefined
    result[key] = sanitized
  }

  if (objectSchema) {
    if (isObject(schema.properties)) {
      const properties = sanitizeRecord(schema.properties)
      if (!properties) return undefined
      result.properties = properties
    }
    result.additionalProperties = false
    if (Array.isArray(schema.required)) result.required = schema.required
  }

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      const items = sanitizeDefinitions(schema.items)
      if (!items) return undefined
      result.items = items
    } else if (isObject(schema.items)) {
      const items = sanitizeSchema(schema.items)
      if (!items) return undefined
      result.items = items
    } else {
      result.items = schema.items
    }
  }

  if (typeof schema.format === "string" && SUPPORTED_FORMATS.has(schema.format)) {
    result.format = schema.format
  }
  const constraints = constraintDescription(schema)
  if (constraints) {
    result.description =
      typeof result.description === "string" ? `${result.description}\n${constraints}` : constraints
  }
  return result
}

function sanitizeRecord(record: JsonObject): JsonObject | undefined {
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") {
      result[key] = value
      continue
    }
    if (!isObject(value)) return undefined
    const sanitized = sanitizeSchema(value)
    if (!sanitized) return undefined
    result[key] = sanitized
  }
  return result
}

function sanitizeDefinitions(values: readonly JsonValue[]): JsonValue[] | undefined {
  const result: JsonValue[] = []
  for (const value of values) {
    if (typeof value === "boolean") {
      result.push(value)
      continue
    }
    if (!isObject(value)) return undefined
    const sanitized = sanitizeSchema(value)
    if (!sanitized) return undefined
    result.push(sanitized)
  }
  return result
}

function constraintDescription(schema: JsonObject): string | undefined {
  const constraints = DESCRIPTION_CONSTRAINTS.flatMap((key) => {
    const value = schema[key]
    return value === undefined || value === false
      ? []
      : [`${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}: ${format(value)}`]
  })
  if (typeof schema.format === "string" && !SUPPORTED_FORMATS.has(schema.format)) {
    constraints.push(`format: ${schema.format}`)
  }
  return constraints.length === 0 ? undefined : `${constraints.join("; ")}.`
}

function format(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
