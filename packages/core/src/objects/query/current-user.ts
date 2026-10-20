import { isCurrentUser, type UserRef } from "../../ontology/user-ref"
import type { ObjectQuery, ObjectQueryPredicate, ObjectQueryPredicateContains } from "./ir"

/**
 * Replace every `currentUser()` of a validated query with the reader's user reference.
 *
 * Validation admits the placeholder only where a predicate compares user references, so storage
 * never receives it. Without a user, as for a service account, a schedule, or a share, `eq`, `in`
 * and `contains` match nothing and `neq` matches every row: it stays the complement of `eq`.
 *
 * The bound query is valid again and holds no placeholder: the executor validates parts of it
 * once more, and binding it twice changes nothing.
 */
export function bindCurrentUser(query: ObjectQuery, user: UserRef | undefined): ObjectQuery {
  switch (query.kind) {
    case "start":
    case "refs":
      return query
    case "filter":
      return {
        ...query,
        input: bindCurrentUser(query.input, user),
        predicate: bindPredicate(query.predicate, user),
      }
    case "set":
      return { ...query, inputs: query.inputs.map((input) => bindCurrentUser(input, user)) }
    default:
      return { ...query, input: bindCurrentUser(query.input, user) }
  }
}

function bindPredicate(
  predicate: ObjectQueryPredicate,
  user: UserRef | undefined
): ObjectQueryPredicate {
  switch (predicate.op) {
    case "and":
    case "or":
      return { ...predicate, items: predicate.items.map((item) => bindPredicate(item, user)) }
    case "not":
      return { ...predicate, item: bindPredicate(predicate.item, user) }
    case "exists":
      return predicate
    case "in": {
      if (!predicate.values.some(isCurrentUser)) return predicate

      const values = predicate.values.flatMap((value) =>
        isCurrentUser(value) ? (user ? [user] : []) : [value]
      )
      return values.length > 0 ? { ...predicate, values } : matchNone(predicate.propertyId)
    }
    case "contains": {
      if (!isCurrentUser(predicate.value)) return predicate
      if (user) return { ...predicate, value: user }

      return containsNone(predicate)
    }
    default: {
      if (!isCurrentUser(predicate.value)) return predicate
      if (user) return { ...predicate, value: user }

      return predicate.op === "neq"
        ? matchAll(predicate.propertyId)
        : matchNone(predicate.propertyId)
    }
  }
}

// Without a user, a predicate is rewritten into a constant built from its own property, because
// the query IR has no constant predicate. Comparing with a reserved user id instead would be
// unsafe: auth strategies choose user ids, so any id could one day name a real user. When object
// policies (#185) add explicit constant predicates to the IR, they can replace these rewrites.
//
// No property is both present and absent, so every provider evaluates that conjunction to false
// on any row, and the disjunction to true.

function matchNone(propertyId: string): ObjectQueryPredicate {
  return { op: "and", items: presence(propertyId) }
}

function matchAll(propertyId: string): ObjectQueryPredicate {
  return { op: "or", items: presence(propertyId) }
}

function presence(propertyId: string): ObjectQueryPredicate[] {
  return [
    { op: "exists", propertyId, value: true },
    { op: "exists", propertyId, value: false },
  ]
}

const ANY_USER: UserRef = Object.freeze({ type: "user", id: "any" })

/**
 * Validation refuses `exists` on a list, so a list's contradiction is built from `contains`
 * itself. The user it names makes no difference: no list both holds and lacks the same one.
 */
function containsNone(predicate: ObjectQueryPredicateContains): ObjectQueryPredicate {
  const item = { ...predicate, value: ANY_USER }
  return { op: "and", items: [item, { op: "not", item }] }
}
