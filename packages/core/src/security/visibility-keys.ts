import { bindCurrentUserPredicate } from "../objects/query/current-user"
import type { ObjectQueryPredicate } from "../objects/query/ir"
import { isCurrentUser, type UserRef } from "../ontology/user-ref"
import type { ObjectReadCondition, ObjectVisibilityKeys } from "../storage/objects/types"

/**
 * The keys of a view condition, or undefined when it has none.
 *
 * A part that never reads `currentUser()` shows an object to everyone holding the condition while
 * it matches. `eq` and `contains` with `currentUser()` show it to the users the property names, and
 * `in` to those and to everyone when another value matches. Two kinds of conditions keep their
 * predicate: negating a comparison with `currentUser()` shows an object to every user but some,
 * and requiring two of them at once, to the users two properties share.
 */
export function viewConditionKeys(
  predicate: ObjectQueryPredicate
): ObjectVisibilityKeys | undefined {
  const part = keyedPart(predicate)
  if (part === undefined) return undefined

  return part === EVERYONE ? { kind: "everyone", when: predicate } : part
}

/**
 * What a reader holding these conditions on one concrete type reads it through: their predicates
 * bound to its user, and, for the conditions that have keys, the same condition as keys.
 */
export function viewConditionReadCondition(
  objectTypeId: string,
  predicates: readonly ObjectQueryPredicate[],
  user: UserRef | undefined
): ObjectReadCondition {
  const keys: ObjectVisibilityKeys[] = []
  const remainder: ObjectQueryPredicate[] = []

  for (const predicate of predicates) {
    const conditionKeys = viewConditionKeys(predicate)
    if (conditionKeys) keys.push(conditionKeys)
    else remainder.push(bindCurrentUserPredicate(predicate, user))
  }

  const bound = bindCurrentUserPredicate(anyOf(predicates), user)
  if (keys.length === 0) return { objectTypeId, predicate: bound }

  return {
    objectTypeId,
    predicate: bound,
    visibility: {
      keys,
      ...(user ? { user } : {}),
      ...(remainder.length > 0 ? { remainder: anyOf(remainder) } : {}),
    },
  }
}

/** A part that reads no `currentUser()`: it shows an object to everyone while it matches. */
const EVERYONE = "everyone"

function keyedPart(
  predicate: ObjectQueryPredicate
): typeof EVERYONE | ObjectVisibilityKeys | undefined {
  if (!readsCurrentUser(predicate)) return EVERYONE

  switch (predicate.op) {
    case "and": {
      const parts = predicate.items.map(keyedPart)
      if (parts.includes(undefined)) return undefined

      const everyone = predicate.items.filter((_, index) => parts[index] === EVERYONE)
      const keyed = parts.filter(isKeys)

      // Each keyed part names its own users: only the users they share would hold all of them.
      if (keyed.length !== 1) return undefined

      return everyone.length === 0
        ? keyed[0]
        : { kind: "when", when: allOf(everyone), keys: keyed[0]! }
    }

    case "or": {
      const parts = predicate.items.map(keyedPart)
      if (parts.includes(undefined)) return undefined

      const everyone = predicate.items.filter((_, index) => parts[index] === EVERYONE)
      const items = [
        ...(everyone.length > 0 ? [{ kind: "everyone" as const, when: anyOf(everyone) }] : []),
        ...parts.filter(isKeys),
      ]
      return items.length === 1 ? items[0] : { kind: "union", items }
    }

    case "eq":
      return { kind: "user", propertyId: predicate.propertyId }

    case "contains":
      return { kind: "users", propertyId: predicate.propertyId }

    case "in": {
      const values = predicate.values.filter((value) => !isCurrentUser(value))
      const user: ObjectVisibilityKeys = { kind: "user", propertyId: predicate.propertyId }
      if (values.length === 0) return user

      return {
        kind: "union",
        items: [{ kind: "everyone", when: { ...predicate, values } }, user],
      }
    }

    default:
      // `not` and `neq` around `currentUser()`.
      return undefined
  }
}

function readsCurrentUser(predicate: ObjectQueryPredicate): boolean {
  switch (predicate.op) {
    case "and":
    case "or":
      return predicate.items.some(readsCurrentUser)
    case "not":
      return readsCurrentUser(predicate.item)
    case "in":
      return predicate.values.some(isCurrentUser)
    case "exists":
    case "constant":
      return false
    default:
      return isCurrentUser(predicate.value)
  }
}

function isKeys(
  part: typeof EVERYONE | ObjectVisibilityKeys | undefined
): part is ObjectVisibilityKeys {
  return typeof part === "object"
}

function allOf(predicates: readonly ObjectQueryPredicate[]): ObjectQueryPredicate {
  return predicates.length === 1 ? predicates[0]! : { op: "and", items: predicates }
}

function anyOf(predicates: readonly ObjectQueryPredicate[]): ObjectQueryPredicate {
  return predicates.length === 1 ? predicates[0]! : { op: "or", items: predicates }
}
