import { isJsonObject, type JsonObject } from "@sixb/core/models"

const KEYS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "format",
])
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
const FORMATS = new Set([
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

/** Conservative Claude decoder subset. Preserve schemas exactly; never strip constraints. */
export function messagesOutputSchema(schema: JsonObject): JsonObject | undefined {
  const active = new Set<JsonObject>()
  const walk = (value: unknown): boolean => {
    if (!isJsonObject(value) || active.has(value)) return false
    if (Object.keys(value).some((key) => !KEYS.has(key))) return false
    active.add(value)
    try {
      for (const key of ["title", "description"])
        if (value[key] !== undefined && typeof value[key] !== "string") return false
      const types = typeof value.type === "string" ? [value.type] : value.type
      if (
        types !== undefined &&
        (!Array.isArray(types) ||
          !types.length ||
          types.some((type) => typeof type !== "string" || !TYPES.has(type)))
      )
        return false
      if (
        value.anyOf !== undefined &&
        (!Array.isArray(value.anyOf) || !value.anyOf.length || !value.anyOf.every(walk))
      )
        return false
      if (
        types === undefined &&
        value.anyOf === undefined &&
        value.const === undefined &&
        value.enum === undefined
      )
        return false
      if (Array.isArray(types) && types.includes("object")) {
        if (!isJsonObject(value.properties) || value.additionalProperties !== false) return false
        if (
          value.required !== undefined &&
          (!Array.isArray(value.required) ||
            value.required.some(
              (key) =>
                typeof key !== "string" || !Object.hasOwn(value.properties as JsonObject, key)
            ))
        )
          return false
        if (!Object.values(value.properties).every(walk)) return false
      } else if (
        value.properties !== undefined ||
        value.required !== undefined ||
        value.additionalProperties !== undefined
      )
        return false
      if (Array.isArray(types) && types.includes("array")) {
        if (!walk(value.items)) return false
      } else if (value.items !== undefined) return false
      if (
        value.format !== undefined &&
        (typeof value.format !== "string" || !FORMATS.has(value.format))
      )
        return false
      if (
        value.enum !== undefined &&
        (!Array.isArray(value.enum) ||
          !value.enum.length ||
          value.enum.some((entry) => typeof entry === "object" && entry !== null))
      )
        return false
      if (value.const !== undefined && typeof value.const === "object" && value.const !== null)
        return false
      return true
    } finally {
      active.delete(value)
    }
  }
  return schema.type === "object" && walk(schema) ? schema : undefined
}
