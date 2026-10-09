import { SecurityValidationError } from "./errors"
import type {
  GrantDefinition,
  GroupDefinition,
  MarkingDefinition,
  MembershipOperation,
  MembershipPolicyDefinition,
  RoleDefinition,
} from "./types"
import {
  assertGrantDefinition,
  assertNonEmptyString,
  assertOptionalString,
  isRecord,
} from "./validation"

export interface DefineGroupOptions {
  readonly label?: string
  readonly description?: string
}

export interface DefineMarkingOptions {
  readonly label?: string
  readonly description?: string
}

export interface DefineRoleOptions {
  readonly label?: string
  readonly description?: string
  readonly grantedTo: readonly GroupDefinition[]
  readonly grants?: readonly GrantDefinition[]
  /** Markings this role's members may read. */
  readonly clearances?: readonly MarkingDefinition[]
}

export interface DefineMembershipPolicyOptions {
  readonly grantedTo: readonly GroupDefinition[]
  readonly scope: readonly GroupDefinition[]
  readonly can: readonly MembershipOperation[]
}

const MEMBERSHIP_OPERATIONS = new Set<MembershipOperation>(["invite", "assignGroups", "suspend"])

function assertNonEmptyArray<T>(value: readonly T[], field: string): void {
  if (value.length === 0) {
    throw new SecurityValidationError(`[Sixb] ${field} must not be empty.`)
  }
}

function groupIdsFrom(groups: readonly GroupDefinition[], field: string): readonly string[] {
  return groups.map((group) => {
    if (!isRecord(group) || group.kind !== "group") {
      throw new SecurityValidationError(`[Sixb] ${field} must contain only group definitions.`)
    }

    assertNonEmptyString(group.id, `${field} group id`)
    return group.id
  })
}

function membershipOperationsFrom(
  operations: readonly MembershipOperation[],
  field: string
): readonly MembershipOperation[] {
  return operations.map((operation) => {
    if (!MEMBERSHIP_OPERATIONS.has(operation)) {
      throw new SecurityValidationError(
        `[Sixb] ${field} must contain only membership operations: invite, assignGroups, suspend.`
      )
    }

    return operation
  })
}

export function defineGroup<const TId extends string>(
  id: TId,
  options: DefineGroupOptions = {}
): GroupDefinition<TId> {
  assertNonEmptyString(id, "Group id")
  assertOptionalString(options.label, `Group '${id}' label`)
  assertOptionalString(options.description, `Group '${id}' description`)

  return {
    kind: "group",
    id,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  }
}

/** Read the ids of marking definitions, rejecting anything else such as a bare id. */
export function markingIdsFrom(
  markings: readonly MarkingDefinition[],
  field: string
): readonly string[] {
  return markings.map((marking) => {
    if (!isRecord(marking) || marking.kind !== "marking") {
      throw new SecurityValidationError(`[Sixb] ${field} must contain only marking definitions.`)
    }

    assertNonEmptyString(marking.id, `${field} marking id`)
    return marking.id
  })
}

export function defineMarking<const TId extends string>(
  id: TId,
  options: DefineMarkingOptions = {}
): MarkingDefinition<TId> {
  assertNonEmptyString(id, "Marking id")
  assertOptionalString(options.label, `Marking '${id}' label`)
  assertOptionalString(options.description, `Marking '${id}' description`)

  return {
    kind: "marking",
    id,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  }
}

export function defineRole<const TId extends string>(
  id: TId,
  options: DefineRoleOptions
): RoleDefinition<TId> {
  assertNonEmptyString(id, "Role id")
  assertOptionalString(options.label, `Role '${id}' label`)
  assertOptionalString(options.description, `Role '${id}' description`)
  assertNonEmptyArray(options.grantedTo, `Role '${id}' grantedTo`)

  const grantedToGroupIds = groupIdsFrom(options.grantedTo, `Role '${id}' grantedTo`)
  const grants = options.grants ?? []
  const clearances = markingIdsFrom(options.clearances ?? [], `Role '${id}' clearances`)

  for (const grant of grants) {
    assertGrantDefinition(grant, `Role '${id}' grants`)
  }

  if (grants.length === 0 && clearances.length === 0) {
    throw new SecurityValidationError(
      `[Sixb] Role '${id}' must declare at least one grant or clearance.`
    )
  }

  return {
    kind: "role",
    id,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    grantedToGroupIds,
    grants,
    ...(clearances.length > 0 ? { clearances } : {}),
  }
}

export function defineMembershipPolicy<const TId extends string>(
  id: TId,
  options: DefineMembershipPolicyOptions
): MembershipPolicyDefinition<TId> {
  assertNonEmptyString(id, "Membership policy id")
  assertNonEmptyArray(options.grantedTo, `Membership policy '${id}' grantedTo`)
  assertNonEmptyArray(options.can, `Membership policy '${id}' can`)

  return {
    kind: "membershipPolicy",
    id,
    grantedToGroupIds: groupIdsFrom(options.grantedTo, `Membership policy '${id}' grantedTo`),
    scopeGroupIds: groupIdsFrom(options.scope, `Membership policy '${id}' scope`),
    can: membershipOperationsFrom(options.can, `Membership policy '${id}' can`),
  }
}
