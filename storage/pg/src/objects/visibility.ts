import type { UserRef } from "@sixb/core"
import type { ObjectReadCondition, ObjectVisibilityKeys } from "@sixb/core/storage"
import { compilePredicate } from "./query-compiler"
import { literal } from "./sql-text"

/**
 * Visibility keys as SQL: one expression over `properties` returning who the condition shows the
 * row to, `*` for everyone holding it and `u:<id>` for a user.
 *
 * The expression is IMMUTABLE and holds its values inline, so PostgreSQL can index it and match a
 * read that repeats it, whatever the reader. A user's id is written as jsonb prints it between its
 * quotes: that is how a list's ids come out of `jsonb_path_query_array` with no subquery, which an
 * index expression cannot hold. jsonb escapes every `"` and control character inside an id, so
 * `", "` only ever separates two of them, and `\x1f` never appears in one.
 *
 * A GIN entry holds at most 2,712 bytes, and jsonb prints a character in up to 6 bytes, so ids
 * longer than `MAX_KEYED_ID_LENGTH` characters get no key: a reader with such an id reads the
 * predicate instead.
 *
 * Reads number every `?` of a statement as a parameter, so none is written: text goes in `E''`
 * strings, where `?` is written `\x3f`.
 */
export function compilePgVisibilityKeys(keys: ObjectVisibilityKeys): string {
  switch (keys.kind) {
    case "everyone":
      return `CASE WHEN ${predicateSql(keys.when)} THEN ARRAY[${text(EVERYONE)}]::text[] ELSE ${NO_KEYS} END`

    case "user": {
      // `eq` compares the whole reference, so the property holds exactly a type and a string id.
      const ref = propertySql(keys.propertyId)
      return `CASE WHEN jsonb_typeof(${ref}) = 'object' AND (${ref} - 'type' - 'id') = '{}'::jsonb AND ${ref} -> 'type' = '"user"'::jsonb AND jsonb_typeof(${ref} -> 'id') = 'string' AND char_length(${ref} ->> 'id') <= ${MAX_KEYED_ID_LENGTH} THEN ARRAY[${text(USER_PREFIX)} || left(substr((${ref} -> 'id')::text, 2), -1)] ELSE ${NO_KEYS} END`
    }

    case "users": {
      // Strict mode keeps the elements `@>` matches: objects whose type is "user" and id a string.
      const path = text(
        `strict $[*] ? (@.type == "user" && @.id.type() == "string" && @.id like_regex "^.{0,${MAX_KEYED_ID_LENGTH}}$" flag "s").id`
      )
      const ids = `jsonb_path_query_array(${propertySql(keys.propertyId)}, ${path}, '{}', true)::text`
      const separator = `E'\\x1f'`
      return `coalesce(string_to_array(${text(USER_PREFIX)} || replace(NULLIF(left(substr(${ids}, 3), -2), ''), '", "', ${separator} || ${text(USER_PREFIX)}), ${separator}), ${NO_KEYS})`
    }

    case "union":
      return `(${keys.items.map((item) => `(${compilePgVisibilityKeys(item)})`).join(" || ")})`

    case "when":
      return `CASE WHEN ${predicateSql(keys.when)} THEN ${compilePgVisibilityKeys(keys.keys)} ELSE ${NO_KEYS} END`
  }
}

/** The keys a reader holds: everyone's, and its user's. */
export function pgVisibilityReaderKeys(user: UserRef | undefined): string[] {
  return user ? [EVERYONE, `${USER_PREFIX}${JSON.stringify(user.id).slice(1, -1)}`] : [EVERYONE]
}

/**
 * A conditioned type's filter: each condition's keys meet the reader's, or the remainder matches.
 * Without keys, or for a user whose id is too long to have one, the condition's predicate.
 */
export function compilePgConditionFilter(condition: ObjectReadCondition): {
  readonly sql: string
  readonly args: readonly unknown[]
} {
  const visibility = condition.visibility
  // UTF-16 code units, never fewer than the characters PostgreSQL counts.
  if (!visibility || (visibility.user?.id.length ?? 0) > MAX_KEYED_ID_LENGTH) {
    return compilePredicate(condition.predicate)
  }

  const readerKeys = pgVisibilityReaderKeys(visibility.user)
  const clauses = visibility.keys.map((keys) => `((${compilePgVisibilityKeys(keys)}) && ?::text[])`)
  const args: unknown[] = visibility.keys.map(() => readerKeys)

  if (visibility.remainder) {
    const remainder = compilePredicate(visibility.remainder)
    clauses.push(remainder.sql)
    args.push(...remainder.args)
  }

  return { sql: `(${clauses.join(" OR ")})`, args }
}

const MAX_KEYED_ID_LENGTH = 200
const EVERYONE = "*"
const USER_PREFIX = "u:"
const NO_KEYS = "'{}'::text[]"

function propertySql(propertyId: string): string {
  return `(properties -> ${text(propertyId)}::text)`
}

function text(value: string): string {
  return literal(value).replace(/\?/g, "\\x3f")
}

/** The reader's own predicate compiler, so a part means exactly what the condition does. */
function predicateSql(predicate: Parameters<typeof compilePredicate>[0]): string {
  const compiled = compilePredicate(predicate)
  let index = 0
  return `(${compiled.sql.replace(/\?/g, () => inlineValue(compiled.args[index++]))})`
}

/** The values the predicate compiler binds: property ids and compared values, text or numbers. */
function inlineValue(value: unknown): string {
  if (typeof value === "string") return text(value)
  if (typeof value === "number" && Number.isFinite(value)) return `(${String(value)})`

  throw new Error(`[SixbPg] A view condition compares a value it cannot index: ${String(value)}.`)
}
