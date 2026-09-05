import type { Principal } from "../auth/types"
import type { RoleDefinition, Selection } from "../security"
import {
  emptyGrantSets,
  GRANT_KINDS,
  type GrantUniverse,
  grantKindOf,
  TARGETED_GRANT_KIND_KEYS,
} from "./grant-kinds"
import type { AuthorizationContext, GrantIndex, ResolvedRole } from "./types"

/**
 * Resolve a role's grants once at startup.
 *
 * Broad grants (`every.object().except([...])`) expand against the registered
 * universe; object-type grants also expand to subtypes. Resource grants become
 * id sets; the project Agent grant becomes a boolean.
 * The per-kind universe and subtype rules come from the `GRANT_KINDS` table, so
 * this loop never enumerates targets by hand.
 */
export function resolveRoleGrants(role: RoleDefinition, universe: GrantUniverse): GrantIndex {
  const grants = emptyGrantSets()

  for (const grant of role.grants) {
    if (grant.capability === "run" && grant.target === "agent") {
      grants["run:agent"] = true
      continue
    }
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
    if (role.grants["run:agent"]) {
      grants["run:agent"] = true
    }
    for (const kind of TARGETED_GRANT_KIND_KEYS) {
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
