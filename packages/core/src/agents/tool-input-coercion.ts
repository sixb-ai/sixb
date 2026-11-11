import type { JsonObject, JsonValue } from "../json"

/**
 * A tool call's arguments as its schema reads them, before the tool's own `parseInput`: the slips
 * models make most, fixed where the schema leaves one reading.
 *
 * ```text
 * null for an optional property that does not allow null   left out
 * "42" for a number or an integer, when it fits exactly     42
 * "true" / "false" for a boolean                           true / false
 * an array as JSON text                                    the array
 * one value for an array                                   [value]
 * ```
 *
 * The `null` is also what a provider's strict mode sends for "nothing" once an adapter rewrites an
 * optional property as required and nullable, so a tool never sees it. Everything else reaches
 * `parseInput` as the model sent it, and a refusal goes back to the model. The call's stored input
 * stays what the model sent, so history replays byte for byte.
 */
export function coerceToolInput(schema: JsonObject, input: unknown): unknown {
  return coerce(schema, input)
}

function coerce(schema: JsonValue | undefined, value: unknown): unknown {
  if (!isObject(schema)) return value
  const types = schemaTypes(schema)
  if (types.length === 0 || types.some((type) => hasType(value, type))) {
    return coerceInside(schema, value)
  }

  if (typeof value === "string") {
    const text = value.trim()
    // An integer past what a number holds exactly would change: an id would name its neighbour.
    if (types.includes("integer") && /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))) {
      return Number(text)
    }
    if (
      types.includes("number") &&
      /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) &&
      Number.isFinite(Number(text))
    ) {
      return Number(text)
    }
    if (types.includes("boolean") && (text === "true" || text === "false")) return text === "true"
    if (types.includes("array") && text.startsWith("[")) {
      const parsed = parseJson(text)
      if (Array.isArray(parsed)) return coerceInside(schema, parsed)
    }
  }
  if (types.includes("array") && value !== null && value !== undefined && !Array.isArray(value)) {
    return [coerce(schema.items, value)]
  }
  return value
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function coerceInside(schema: JsonObject, value: unknown): unknown {
  if (Array.isArray(value)) {
    return isObject(schema.items) ? value.map((item) => coerce(schema.items, item)) : value
  }
  if (!isPlainObject(value) || !isObject(schema.properties)) return value

  const properties = schema.properties
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (item === null && property !== undefined && !required.has(key) && !allowsNull(property)) {
      continue
    }
    result[key] = property === undefined ? item : coerce(property, item)
  }
  return result
}

/** The schema's own `type`s; a union (`anyOf`, `oneOf`) is read as it is, never coerced into. */
function schemaTypes(schema: JsonObject): readonly string[] {
  if (typeof schema.type === "string") return [schema.type]
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type): type is string => typeof type === "string")
  }
  return []
}

function allowsNull(schema: JsonValue): boolean {
  if (schema === true) return true
  if (!isObject(schema)) return false
  if (schemaTypes(schema).includes("null")) return true
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) {
    return true
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key]
    if (Array.isArray(variants) && variants.some(allowsNull)) return true
  }
  // Nothing that narrows it: any value, null included.
  return (
    schemaTypes(schema).length === 0 &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined &&
    schema.enum === undefined &&
    schema.const === undefined
  )
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number"
    case "integer":
      return Number.isInteger(value)
    case "array":
      return Array.isArray(value)
    case "object":
      return isPlainObject(value)
    default:
      return true
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
