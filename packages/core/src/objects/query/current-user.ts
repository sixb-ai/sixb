import { isCurrentUser, type UserRef } from "../../ontology/user-ref"
import type { ObjectQuery, ObjectQueryPredicate } from "./ir"

/**
 * Replace every `currentUser()` of a validated query with the reader's user reference.
 *
 * Validation admits the placeholder only where a predicate compares user references, so storage
 * never receives it. Without a user, as for a service account, a schedule, or a share, `eq`, `in`
 * and `contains` become a constant that matches nothing, and `neq` one that matches every row: it
 * stays the complement of `eq`.
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
    case "constant":
      return predicate
    case "in": {
      if (!predicate.values.some(isCurrentUser)) return predicate

      const values = predicate.values.flatMap((value) =>
        isCurrentUser(value) ? (user ? [user] : []) : [value]
      )
      return values.length > 0 ? { ...predicate, values } : NO_ROW
    }
    case "contains": {
      if (!isCurrentUser(predicate.value)) return predicate
      if (user) return { ...predicate, value: user }

      return NO_ROW
    }
    default: {
      if (!isCurrentUser(predicate.value)) return predicate
      if (user) return { ...predicate, value: user }

      return predicate.op === "neq" ? EVERY_ROW : NO_ROW
    }
  }
}

// A constant rather than a comparison with a reserved user id: auth strategies choose user ids, so
// any id could one day name a real user.
const NO_ROW: ObjectQueryPredicate = Object.freeze({ op: "constant", value: false })
const EVERY_ROW: ObjectQueryPredicate = Object.freeze({ op: "constant", value: true })
