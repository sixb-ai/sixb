import { SecurityValidationError } from "./errors"
import type {
  GrantDefinition,
  GroupDefinition,
  InvitePolicyDefinition,
  RoleDefinition,
} from "./types"
import {
  assertGrantDefinition,
  assertNonEmptyString,
  assertOptionalBoolean,
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

export interface DefineInvitePolicyOptions {
  readonly grantedTo: readonly GroupDefinition[]
  readonly canInviteTo?: readonly GroupDefinition[]
  readonly canInviteWithoutGroups?: boolean
}

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
    throw new SecurityValidationError(`[Sixb] Role '${id}' grants must not be empty.`)
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

export function defineInvitePolicy<const TId extends string>(
  id: TId,
  options: DefineInvitePolicyOptions
): InvitePolicyDefinition<TId> {
  assertNonEmptyString(id, "Invite policy id")
  assertOptionalBoolean(
    options.canInviteWithoutGroups,
    `Invite policy '${id}' canInviteWithoutGroups`
  )
  assertNonEmptyArray(options.grantedTo, `Invite policy '${id}' grantedTo`)

  const grantedToGroupIds = groupIdsFrom(options.grantedTo, `Invite policy '${id}' grantedTo`)
  const canInviteToGroupIds = groupIdsFrom(
    options.canInviteTo ?? [],
    `Invite policy '${id}' canInviteTo`
  )

  if (canInviteToGroupIds.length === 0 && options.canInviteWithoutGroups !== true) {
    throw new SecurityValidationError(
      `[Sixb] Invite policy '${id}' must declare canInviteTo groups or canInviteWithoutGroups.`
    )
  }

  return {
    kind: "invitePolicy",
    id,
    grantedToGroupIds,
    canInviteToGroupIds,
    ...(options.canInviteWithoutGroups !== undefined
      ? { canInviteWithoutGroups: options.canInviteWithoutGroups }
      : {}),
  }
}
