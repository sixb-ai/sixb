export type JsonPrimitive = string | number | boolean | null
export type JsonObject = { [key: string]: JsonValue }
export type JsonArray = JsonValue[]
export type JsonValue = JsonPrimitive | JsonObject | JsonArray

/** JSON-compatible input that also accepts readonly containers from typed application code. */
export type ReadonlyJsonObject = {
  readonly [key: string]: ReadonlyJsonValue
}
export type ReadonlyJsonArray = readonly ReadonlyJsonValue[]
export type ReadonlyJsonValue = JsonPrimitive | ReadonlyJsonObject | ReadonlyJsonArray

export function isJsonValue(value: unknown): value is JsonValue {
  return getInvalidJsonValueReason(value) === undefined
}

export function assertJsonValue(value: unknown, label = "value"): asserts value is JsonValue {
  const reason = getInvalidJsonValueReason(value, label)
  if (reason) {
    throw new Error(`[Sixb] ${label} must be a JSON value; ${reason}`)
  }
}

export function cloneJsonValue(value: ReadonlyJsonValue, label = "value"): JsonValue {
  assertJsonValue(value, label)
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`
}

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function getInvalidJsonValueReason(
  value: unknown,
  label = "value",
  seen: Set<object> = new Set()
): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return undefined
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${label} is not a finite number`
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return `${label} contains a circular reference`
    }

    seen.add(value)
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        seen.delete(value)
        return `${label}[${index}] is a sparse array slot`
      }

      const reason = getInvalidJsonValueReason(value[index], `${label}[${index}]`, seen)
      if (reason) {
        seen.delete(value)
        return reason
      }
    }
    seen.delete(value)
    return undefined
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      return `${label} contains a circular reference`
    }

    const symbolKeys = Object.getOwnPropertySymbols(value).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(value, key)
    )
    if (symbolKeys.length > 0) {
      return `${label} has an enumerable symbol key`
    }

    seen.add(value)
    for (const [key, entry] of Object.entries(value)) {
      const reason = getInvalidJsonValueReason(entry, jsonChildPath(label, key), seen)
      if (reason) {
        seen.delete(value)
        return reason
      }
    }
    seen.delete(value)
    return undefined
  }

  return `${label} is ${describeNonJsonValue(value)}`
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function jsonChildPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function describeNonJsonValue(value: unknown): string {
  if (value === undefined) {
    return "undefined"
  }

  if (value instanceof Date) {
    return "a Date"
  }

  const type = typeof value
  if (type === "bigint" || type === "function" || type === "symbol") {
    return `a ${type}`
  }

  if (typeof value === "object" && value !== null) {
    const name = value.constructor?.name
    return name ? `a ${name}` : "a non-plain object"
  }

  return type
}
