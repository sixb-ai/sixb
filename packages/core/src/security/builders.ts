import { SixbError } from "../errors"
import type {
  GrantDefinition,
  GroupDefinition,
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

export interface DefineRoleOptions {
  readonly label?: string
  readonly description?: string
  readonly grantedTo: readonly GroupDefinition[]
  readonly grants: readonly GrantDefinition[]
}

export interface DefineMembershipPolicyOptions {
  readonly grantedTo: readonly GroupDefinition[]
  readonly scope: readonly GroupDefinition[]
  readonly can: readonly MembershipOperation[]
}

const MEMBERSHIP_OPERATIONS = new Set<MembershipOperation>(["invite", "assignGroups", "suspend"])

function assertNonEmptyArray<T>(value: readonly T[], field: string): void {
  if (value.length === 0) {
    throw new SixbError("runtime.invalid_definition", `[Sixb] ${field} must not be empty.`)
  }
}

function groupIdsFrom(groups: readonly GroupDefinition[], field: string): readonly string[] {
  return groups.map((group) => {
    if (!isRecord(group) || group.kind !== "group") {
      throw new SixbError(
        "runtime.invalid_definition",
        `[Sixb] ${field} must contain only group definitions.`
      )
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
      throw new SixbError(
        "runtime.invalid_definition",
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

export function defineRole<const TId extends string>(
  id: TId,
  options: DefineRoleOptions
): RoleDefinition<TId> {
  assertNonEmptyString(id, "Role id")
  assertOptionalString(options.label, `Role '${id}' label`)
  assertOptionalString(options.description, `Role '${id}' description`)
  assertNonEmptyArray(options.grantedTo, `Role '${id}' grantedTo`)

  const grantedToGroupIds = groupIdsFrom(options.grantedTo, `Role '${id}' grantedTo`)

  for (const grant of options.grants) {
    assertGrantDefinition(grant, `Role '${id}' grants`)
  }

  if (options.grants.length === 0) {
    throw new SixbError(
      "runtime.invalid_definition",
      `[Sixb] Role '${id}' grants must not be empty.`
    )
  }

  return {
    kind: "role",
    id,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    grantedToGroupIds,
    grants: options.grants,
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
