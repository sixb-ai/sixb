import { SecurityValidationError } from "./errors"
import type { GroupDefinition, InvitePolicyDefinition } from "./types"

export interface DefineGroupOptions {
  readonly label?: string
  readonly description?: string
}

export interface DefineInvitePolicyOptions {
  readonly grantedTo: readonly GroupDefinition[]
  readonly canInviteTo?: readonly GroupDefinition[]
  readonly canInviteWithoutGroups?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SecurityValidationError(`${field} must not be empty.`)
  }
}

function assertOptionalString(value: unknown, field: string): asserts value is string | undefined {
  if (value === undefined) {
    return
  }

  if (typeof value !== "string") {
    throw new SecurityValidationError(`${field} must be a string.`)
  }
}

function assertOptionalBoolean(
  value: unknown,
  field: string
): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new SecurityValidationError(`${field} must be a boolean.`)
  }
}

function assertNonEmptyArray<T>(value: readonly T[], field: string): void {
  if (value.length === 0) {
    throw new SecurityValidationError(`${field} must not be empty.`)
  }
}

function groupIdsFrom(groups: readonly GroupDefinition[], field: string): readonly string[] {
  return groups.map((group) => {
    if (!isRecord(group) || group.kind !== "group") {
      throw new SecurityValidationError(`${field} must contain only group definitions.`)
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
      `Invite policy '${id}' must declare canInviteTo groups or canInviteWithoutGroups.`
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
