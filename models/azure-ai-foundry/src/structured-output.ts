import { isJsonObject, type JsonObject } from "@sixb/core/models"

const KEYWORDS = new Set([
  "type",
  "description",
  "title",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "$ref",
  "$defs",
  "definitions",
])
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])

/** Azure's documented strict subset. Never weaken the caller's validation contract. */
export function foundryOutputSchema(schema: JsonObject): JsonObject | undefined {
  // Count the actual wire tree: reusing a JS object at two property locations still sends it twice.
  let root: unknown
  try {
    root = JSON.parse(JSON.stringify(schema))
  } catch {
    return undefined
  }
  if (!isJsonObject(root)) return undefined
  const wire = root
  const counted = new Set<JsonObject>()
  const validated = new Map<JsonObject, Set<number>>()
  let properties = 0
  const reference = (ref: string): JsonObject | undefined => {
    if (ref === "#") return wire
    if (!ref.startsWith("#/")) return undefined
    let value: unknown = wire
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~")
      if (!isJsonObject(value) || !Object.hasOwn(value, key)) return undefined
      value = value[key]
    }
    return isJsonObject(value) ? value : undefined
  }
  const walk = (value: unknown, depth: number, active: ReadonlySet<JsonObject>): boolean => {
    if (!isJsonObject(value)) return false
    if (active.has(value)) return value.type === "object" || value.type === "array"
    if (validated.get(value)?.has(depth)) return true
    if (Object.keys(value).some((key) => !KEYWORDS.has(key))) return false
    for (const key of ["description", "title"]) {
      if (value[key] !== undefined && typeof value[key] !== "string") return false
    }
    const next = new Set(active).add(value)
    if (value.$ref !== undefined) {
      if (typeof value.$ref !== "string" || !walk(reference(value.$ref), depth, next)) return false
    }
    const types = typeof value.type === "string" ? [value.type] : value.type
    if (
      types !== undefined &&
      (!Array.isArray(types) ||
        types.length === 0 ||
        types.some((t) => typeof t !== "string" || !TYPES.has(t)) ||
        (Array.isArray(value.type) &&
          (types.length !== 2 || !types.includes("null") || new Set(types).size !== 2)))
    )
      return false
    const objectType = Array.isArray(types) && types.includes("object")
    const arrayType = Array.isArray(types) && types.includes("array")
    const level = depth + (objectType || arrayType ? 1 : 0)
    if (level > 5) return false
    if (objectType) {
      if (
        !isJsonObject(value.properties) ||
        value.additionalProperties !== false ||
        !Array.isArray(value.required)
      )
        return false
      const keys = Object.keys(value.properties)
      const required = value.required
      if (
        required.length !== keys.length ||
        new Set(required).size !== keys.length ||
        keys.some((key) => !required.includes(key))
      )
        return false
      if (!counted.has(value)) {
        counted.add(value)
        properties += keys.length
      }
      if (
        properties > 100 ||
        !Object.values(value.properties).every((child) => walk(child, level, next))
      )
        return false
    } else if (
      value.properties !== undefined ||
      value.required !== undefined ||
      value.additionalProperties !== undefined
    )
      return false
    if (arrayType && !walk(value.items, level, next)) return false
    if (!arrayType && value.items !== undefined) return false
    if (
      value.anyOf !== undefined &&
      (!Array.isArray(value.anyOf) ||
        value.anyOf.length === 0 ||
        !value.anyOf.every((child) => walk(child, level, next)))
    )
      return false
    if (value.type === undefined && value.$ref === undefined && value.anyOf === undefined)
      return false
    if (
      value.enum !== undefined &&
      (!Array.isArray(value.enum) ||
        value.enum.length === 0 ||
        value.enum.some((entry) => typeof entry === "object" && entry !== null))
    )
      return false
    for (const key of ["$defs", "definitions"]) {
      const definitions = value[key]
      if (
        definitions !== undefined &&
        (!isJsonObject(definitions) ||
          !Object.values(definitions).every((child) => walk(child, 0, next)))
      )
        return false
    }
    const depths = validated.get(value) ?? new Set<number>()
    depths.add(depth)
    validated.set(value, depths)
    return true
  }
  return wire.type === "object" && wire.anyOf === undefined && walk(wire, 0, new Set())
    ? schema
    : undefined
}
