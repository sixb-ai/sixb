import type { Principal } from "../auth/types"
import type { RoleDefinition, Selection } from "../security"
import {
  emptyGrantSets,
  GRANT_KIND_KEYS,
  GRANT_KINDS,
  type GrantUniverse,
  grantKindOf,
} from "./grant-kinds"
import type { AuthorizationContext, GrantIndex, ResolvedRole } from "./types"

/**
 * Expand a role's grants into concrete id sets once at startup.
 *
 * Broad grants (`every.object().except([...])`) expand against the registered
 * universe; object-type grants also expand to subtypes. The result holds only
 * `Set`s, so per-request resolution and runtime checks stay simple `set.has`.
 * The per-kind universe and subtype rules come from the `GRANT_KINDS` table, so
 * this loop never enumerates targets by hand.
 */
export function resolveRoleGrants(role: RoleDefinition, universe: GrantUniverse): GrantIndex {
  const grants = emptyGrantSets()

  for (const grant of role.grants) {
    const kind = grantKindOf(grant)
    const spec = GRANT_KINDS[kind]
    expandSelection(
      grant.selection,
      universe[spec.universeKey],
      grants[kind],
      spec.expandsSubtypes ? universe.getSubTypes : undefined
    )
  }

  return grants
}

function expandSelection(
  selection: Selection,
  universe: ReadonlySet<string>,
  into: Set<string>,
  expand?: (id: string) => readonly string[]
): void {
  if (selection.all) {
    const except = new Set(selection.except)
    for (const id of universe) {
      if (!except.has(id)) {
        into.add(id)
      }
    }
    return
  }

  for (const id of selection.ids) {
    into.add(id)
    if (expand) {
      for (const subTypeId of expand(id)) {
        into.add(subTypeId)
      }
    }
  }
}

/**
 * Resolve a principal's authorization context from its group memberships.
 *
 * Pure set-union over pre-resolved roles: roles match when their grantedTo
 * groups intersect the principal's memberships, and their concrete id sets
 * union into the principal's grant index.
 */
export function resolveAuthorizationContext(input: {
  readonly principal: Principal
  readonly sessionId?: string
  readonly groupIds: readonly string[]
  readonly roles: readonly ResolvedRole[]
}): AuthorizationContext {
  const memberGroupIds = new Set(input.groupIds)
  const roleIds: string[] = []
  const grants = emptyGrantSets()

  for (const role of input.roles) {
    if (!role.grantedToGroupIds.some((groupId) => memberGroupIds.has(groupId))) {
      continue
    }

    roleIds.push(role.id)
    for (const kind of GRANT_KIND_KEYS) {
      for (const id of role.grants[kind]) {
        grants[kind].add(id)
      }
    }
  }

  return {
    principal: input.principal,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    groupIds: input.groupIds,
    roleIds,
    grants,
  }
}
