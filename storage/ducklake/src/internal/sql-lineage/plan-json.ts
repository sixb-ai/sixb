import { reject, rejectPlanFormat } from "./rejection"

/**
 * Strict readers for DuckDB's JSON serializers (`json_serialize_sql`, `json_serialize_plan`).
 *
 * The format is not a stable DuckDB API. Every field the analysis reads must be present with the
 * expected shape, so a renamed or retyped field in a future release rejects the transform instead
 * of silently dropping a dependency.
 */
export type JsonObject = Readonly<Record<string, unknown>>

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asObject(value: unknown, what: string): JsonObject {
  if (!isJsonObject(value)) {
    rejectPlanFormat(`${what} is not an object`)
  }

  return value
}

/** A field the serializer always writes. It may be null. */
export function field(object: JsonObject, key: string): unknown {
  if (!Object.hasOwn(object, key)) {
    rejectPlanFormat(`missing field '${key}'`)
  }

  return object[key]
}

export function objectField(object: JsonObject, key: string): JsonObject {
  return asObject(field(object, key), `field '${key}'`)
}

export function nullableObjectField(object: JsonObject, key: string): JsonObject | null {
  const value = field(object, key)
  return value === null ? null : asObject(value, `field '${key}'`)
}

export function stringField(object: JsonObject, key: string): string {
  const value = field(object, key)
  if (typeof value !== "string") {
    rejectPlanFormat(`field '${key}' is not a string`)
  }

  return value
}

export function booleanField(object: JsonObject, key: string): boolean {
  const value = field(object, key)
  if (typeof value !== "boolean") {
    rejectPlanFormat(`field '${key}' is not a boolean`)
  }

  return value
}

/**
 * Indexes and table indexes. DuckDB writes 2^64-1 as an "unset" sentinel, which `JSON.parse`
 * rounds; it stays an integer far past any column count, which is all the analysis compares.
 */
export function indexField(object: JsonObject, key: string): number {
  return asIndex(field(object, key), `field '${key}'`)
}

function asIndex(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    rejectPlanFormat(`${what} is not an index`)
  }

  return value
}

/** A list field. The serializer writes an absent list as null or as an empty array. */
export function listField(object: JsonObject, key: string): readonly unknown[] {
  return asList(field(object, key), `field '${key}'`)
}

export function asList(value: unknown, what: string): readonly unknown[] {
  if (value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    rejectPlanFormat(`${what} is not a list`)
  }

  return value
}

export function objectListField(object: JsonObject, key: string): readonly JsonObject[] {
  return listField(object, key).map((item) => asObject(item, `an item of '${key}'`))
}

export function indexListField(object: JsonObject, key: string): readonly number[] {
  return asIndexList(field(object, key), `field '${key}'`)
}

export function asIndexList(value: unknown, what: string): readonly number[] {
  return asList(value, what).map((item) => asIndex(item, `an item of ${what}`))
}

export function stringListField(object: JsonObject, key: string): readonly string[] {
  return listField(object, key).map((item) => {
    if (typeof item !== "string") {
      rejectPlanFormat(`an item of '${key}' is not a string`)
    }

    return item
  })
}

/**
 * Both serializers answer `{ "error": false, <listKey>: [...] }`, or `{ "error": true,
 * "error_message": ... }` when DuckDB could not parse or bind the query.
 */
export function parseSerializerOutput(
  text: string,
  listKey: string,
  failure: string
): readonly unknown[] {
  const output = asObject(JSON.parse(text), "serializer output")
  if (booleanField(output, "error")) {
    reject(`${failure}: ${stringField(output, "error_message")}`)
  }

  return listField(output, listKey)
}
