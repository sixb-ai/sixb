import type { ObjectExpansion, ObjectQuery } from "./ir"

/**
 * The `ref.user()` properties a query expands, at its rows and under each expanded link.
 *
 * Profiles come from the member directory, not object storage, so the authorized reader attaches
 * them to the rows storage returned.
 */
export interface UserExpansionPlan {
  readonly users: readonly string[]
  readonly links: readonly { readonly linkId: string; readonly plan: UserExpansionPlan }[]
}

/**
 * Read the user expansions of a normalized query, or `undefined` when it has none.
 *
 * Only the outermost expand can carry them: normalization hoists expansions there, and validation
 * refuses them on a set operand.
 */
export function userExpansionPlan(query: ObjectQuery): UserExpansionPlan | undefined {
  if (query.kind !== "expand") return undefined
  return planOf(query.users, query.expansions)
}

function planOf(
  users: readonly string[] | undefined,
  expansions: readonly ObjectExpansion[]
): UserExpansionPlan | undefined {
  const links = expansions.flatMap((expansion) => {
    const plan = planOf(expansion.users, expansion.expand ?? [])
    return plan ? [{ linkId: expansion.linkId, plan }] : []
  })

  if ((users === undefined || users.length === 0) && links.length === 0) return undefined
  return { users: users ?? [], links }
}

/**
 * The query storage runs: user expansions removed at every level, and an expand left with no link
 * replaced by its input. A query that only expands user properties then plans like the plain query.
 */
export function withoutUserExpansions(query: ObjectQuery): ObjectQuery {
  switch (query.kind) {
    case "start":
    case "refs":
      return query
    case "set":
      return { ...query, inputs: query.inputs.map(withoutUserExpansions) }
    case "expand": {
      const input = withoutUserExpansions(query.input)
      if (query.expansions.length === 0) return input

      const { users: _users, ...expand } = query
      return { ...expand, input, expansions: query.expansions.map(withoutExpansionUsers) }
    }
    default:
      return { ...query, input: withoutUserExpansions(query.input) }
  }
}

function withoutExpansionUsers(expansion: ObjectExpansion): ObjectExpansion {
  const { users: _users, ...rest } = expansion
  if (!rest.expand) return rest
  return { ...rest, expand: rest.expand.map(withoutExpansionUsers) }
}
