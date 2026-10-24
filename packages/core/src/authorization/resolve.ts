import type { Principal } from "../auth/types"
import type { ObjectQueryPredicate } from "../objects/query/ir"
import type { RoleDefinition, Selection } from "../security"
import {
  emptyGrantSets,
  GRANT_KINDS,
  type GrantUniverse,
  grantKindOf,
  isSingletonGrantKind,
  SINGLETON_GRANT_KIND_KEYS,
  TARGETED_GRANT_KIND_KEYS,
} from "./grant-kinds"
import type { AuthorizationContext, GrantIndex, ResolvedRole } from "./types"

/**
 * Resolve a role's grants once at startup.
 *
 * Broad grants (`every.object().except([...])`) expand against the registered
 * universe; object-type grants also expand to subtypes. Resource grants become
 * id sets; grants on one project-wide surface (the member directory, the Agent, logs, AI usage)
 * become booleans.
 * The per-kind universe and subtype rules come from the `GRANT_KINDS` table, so
 * this loop never enumerates targets by hand.
 *
 * A view grant with a condition grants no type here: see {@link resolveRoleViewConditions}.
 */
export function resolveRoleGrants(role: RoleDefinition, universe: GrantUniverse): GrantIndex {
  const grants = emptyGrantSets()

  for (const grant of role.grants) {
    if ("condition" in grant && grant.condition !== undefined) continue

    const kind = grantKindOf(grant)
    if (isSingletonGrantKind(kind)) {
      grants[kind] = true
      continue
    }
    // Every other kind carries a selection; this narrows the grant's type to say so.
    if (!("selection" in grant)) continue
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

/**
 * Resolve a role's conditional view grants once at startup, from their validated conditions.
 *
 * A condition applies to the type its grant names and to each subtype, as a view grant does.
 * Several conditions on one type combine with `or`, and a type the role also views without a
 * condition drops them: the role shows every object of it.
 */
export function resolveRoleViewConditions(
  conditions: readonly {
    readonly objectTypeId: string
    readonly predicate: ObjectQueryPredicate
  }[],
  grants: GrantIndex,
  universe: GrantUniverse
): ReadonlyMap<string, ObjectQueryPredicate> {
  const byType = new Map<string, ObjectQueryPredicate[]>()

  for (const condition of conditions) {
    const objectTypeIds = [condition.objectTypeId, ...universe.getSubTypes(condition.objectTypeId)]

    for (const objectTypeId of objectTypeIds) {
      if (grants["view:object"].has(objectTypeId)) continue

      const predicates = byType.get(objectTypeId) ?? []
      predicates.push(condition.predicate)
      byType.set(objectTypeId, predicates)
    }
  }

  return new Map(
    [...byType].map(([objectTypeId, predicates]) => [objectTypeId, anyOf(predicates)] as const)
  )
}

function anyOf(predicates: readonly ObjectQueryPredicate[]): ObjectQueryPredicate {
  if (predicates.length === 1) return predicates[0]!
  return Object.freeze({ op: "or", items: Object.freeze([...predicates]) })
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
 * and clearances union into the principal's context.
 *
 * View conditions union too: the principal sees an object any of them matches. A type one role
 * views without a condition is viewed whole, whatever conditions the others put on it.
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
  const clearances = new Set<string>()
  const viewConditions = new Map<string, ObjectQueryPredicate[]>()

  for (const role of input.roles) {
    if (!role.grantedToGroupIds.some((groupId) => memberGroupIds.has(groupId))) {
      continue
    }

    roleIds.push(role.id)
    for (const kind of SINGLETON_GRANT_KIND_KEYS) {
      if (role.grants[kind]) grants[kind] = true
    }
    for (const kind of TARGETED_GRANT_KIND_KEYS) {
      for (const id of role.grants[kind]) {
        grants[kind].add(id)
      }
    }
    for (const markingId of role.clearances ?? []) {
      clearances.add(markingId)
    }
    for (const [objectTypeId, predicate] of role.viewConditions ?? []) {
      viewConditions.set(objectTypeId, [...(viewConditions.get(objectTypeId) ?? []), predicate])
    }
  }

  for (const objectTypeId of grants["view:object"]) {
    viewConditions.delete(objectTypeId)
  }

  return {
    principal: input.principal,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    groupIds: input.groupIds,
    roleIds,
    grants,
    ...(viewConditions.size > 0 ? { viewConditions } : {}),
    clearances,
  }
}
