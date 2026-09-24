import type { Principal } from "../auth/types"
import type { UserStatus } from "../storage/auth/types"
import { OntologyValidationError } from "./errors"
import type { Schema, ValueType } from "./types"

/**
 * Value of a `ref.user()` (`"userRef"`) schema: the principal shape, narrowed to users.
 *
 * It carries no display data on purpose: a name or avatar supplied by the writer would be
 * spoofable. It grants or restricts nothing by itself either; only an explicit policy gives it a
 * security meaning.
 */
export type UserRef = Extract<Principal, { readonly type: "user" }>

/**
 * Build a reference to one user, for writes and query predicates:
 * `where(({ p }) => p.assignee.eq(userRef(userId)))`.
 */
export function userRef(id: string): UserRef {
  if (typeof id !== "string" || !id.trim()) {
    throw new OntologyValidationError("[Sixb] User reference id must not be empty.")
  }
  return Object.freeze({ type: "user" as const, id })
}

/** Exactly `{ type: "user", id }` with a nonblank id and no other field. */
export function isUserRef(value: unknown): value is UserRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).every((key) => key === "type" || key === "id") &&
    record.type === "user" &&
    typeof record.id === "string" &&
    record.id.trim().length > 0
  )
}

/**
 * Collect the user ids a value holds at `userRef` positions of its schema, however deeply nested.
 *
 * Positions whose value does not match the schema are skipped: shape validation reports them.
 */
export function collectUserRefIds(
  schema: Schema,
  value: unknown,
  valueTypesById: ReadonlyMap<string, ValueType>,
  into: Set<string>,
  seenValueTypeIds: ReadonlySet<string> = new Set()
): Set<string> {
  if (value === null || value === undefined) return into
  if (typeof schema === "string") {
    if (schema === "userRef" && isUserRef(value)) into.add(value.id)
    return into
  }
  switch (schema.type) {
    case "array":
      if (Array.isArray(value)) {
        for (const item of value) {
          collectUserRefIds(schema.items, item, valueTypesById, into, seenValueTypeIds)
        }
      }
      return into
    case "map":
      if (isRecord(value)) {
        for (const item of Object.values(value)) {
          collectUserRefIds(schema.valueSchema, item, valueTypesById, into, seenValueTypeIds)
        }
      }
      return into
    case "object":
      if (isRecord(value)) {
        for (const [fieldId, field] of Object.entries(schema.properties)) {
          collectUserRefIds(field.schema, value[fieldId], valueTypesById, into, seenValueTypeIds)
        }
      }
      return into
    case "valueTypeRef": {
      if (seenValueTypeIds.has(schema.valueTypeId)) return into
      const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
      if (!resolved) return into
      return collectUserRefIds(
        resolved,
        value,
        valueTypesById,
        into,
        new Set([...seenValueTypeIds, schema.valueTypeId])
      )
    }
    case "enum":
      return into
  }
}

/**
 * Why `path` cannot newly reference user `id`, or `undefined` when it can.
 *
 * `status` is the user's status, `null` for an unknown id, or `"unverifiable"` without auth
 * storage. Unknown and suspended users get distinct messages: the writer already holds the id, and
 * telling "wrong id" from "suspended member" is what makes the error actionable.
 */
export function userReferenceProblem(
  path: string,
  id: string,
  status: UserStatus | null | "unverifiable"
): string | undefined {
  switch (status) {
    case "active":
      return undefined
    case null:
      return `[Sixb] ${path} references user '${id}', which does not exist.`
    case "unverifiable":
      return `[Sixb] ${path} references user '${id}', but this runtime has no auth storage to verify users. Configure storage with auth to write user references.`
    default:
      return `[Sixb] ${path} references user '${id}', who is ${status}. Only active users can be newly referenced; existing references are kept.`
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
