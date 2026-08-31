export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true
  }
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen))
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return false
    }
    return Object.values(value).every((entry) => entry !== undefined && isJsonValue(entry, seen))
  } finally {
    seen.delete(value)
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`[SixbLlm] ${label} must be a finite, acyclic JSON value.`)
  }
}

export function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`[SixbLlm] ${label} must be a JSON object.`)
  }
}
