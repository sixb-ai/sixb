import { isJsonObject, type JsonObject, type JsonValue } from "@sixb/core/models"

export function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

/**
 * `JSON.stringify` with every object's keys sorted. A replay serializes what storage returns, and
 * Postgres `jsonb` hands objects back in its own key order: sorting here, live and on replay, sends
 * the same bytes whatever the storage did, so the provider's prompt cache keeps the prefix.
 * Everything but the key order is `JSON.stringify`'s: `toJSON`, dropped `undefined` members.
 * Core's `stableJsonStringify` sorts keys too, but prints `undefined` where `JSON.stringify` drops
 * the member or writes `null`: its output is not JSON, so it cannot print a request body.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => sortedKeys(current))
}

/** A copy of a JSON value whose objects hold their keys sorted, as the request body prints them. */
export function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value === null || typeof value !== "object") return value

  const sorted: JsonObject = {}
  for (const key of Object.keys(value).sort(compareKeys)) {
    sorted[key] = canonicalJson(value[key] as JsonValue)
  }
  return sorted
}

function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  // `JSON.stringify` unwraps these itself; a copy would print an object.
  if (value instanceof Number || value instanceof String || value instanceof Boolean) return value

  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort(compareKeys)) sorted[key] = record[key]
  return sorted
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
