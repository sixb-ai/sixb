import { SecurityValidationError } from "./errors"
import type {
  GroupDefinition,
  InvitePolicyDefinition,
  RegisteredSecurityDefinitions,
} from "./types"

type CreateSecurityError = (message: string) => Error

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createError(`${field} must not be empty.`)
  }
}

function assertOptionalString(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is string | undefined {
  if (value === undefined) {
    return
  }

  if (typeof value !== "string") {
    throw createError(`${field} must be a string.`)
  }
}

function assertStringArray(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw createError(`${field} must be an array of group ids.`)
  }

  for (const item of value) {
    assertNonEmptyString(item, `${field} item`, createError)
  }
}

function assertOptionalBoolean(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is boolean | undefined {
  if (value === undefined) {
    return
  }

  if (typeof value !== "boolean") {
    throw createError(`${field} must be a boolean.`)
  }
}

function assertNoDuplicateIds(ids: readonly string[], field: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new SecurityValidationError(`${field} contains duplicate group id '${id}'.`)
    }
    seen.add(id)
  }
}

export function assertGroupDefinition(
  value: unknown,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is GroupDefinition {
  if (!isRecord(value)) {
    throw createError("Group definition must be an object.")
  }

  if (value.kind !== "group") {
    throw createError("Group definition kind must be 'group'.")
  }

  assertNonEmptyString(value.id, "Group id", createError)
  assertOptionalString(value.label, `Group '${value.id}' label`, createError)
  assertOptionalString(value.description, `Group '${value.id}' description`, createError)
}

export function isGroupDefinition(value: unknown): value is GroupDefinition {
  try {
    assertGroupDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

export function assertInvitePolicyDefinition(
  value: unknown,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is InvitePolicyDefinition {
  if (!isRecord(value)) {
    throw createError("Invite policy definition must be an object.")
  }

  if (value.kind !== "invitePolicy") {
    throw createError("Invite policy definition kind must be 'invitePolicy'.")
  }

  assertNonEmptyString(value.id, "Invite policy id", createError)
  assertStringArray(value.grantedToGroupIds, `Invite policy '${value.id}' grantedTo`, createError)
  assertStringArray(
    value.canInviteToGroupIds,
    `Invite policy '${value.id}' canInviteTo`,
    createError
  )
  assertOptionalBoolean(
    value.canInviteWithoutGroups,
    `Invite policy '${value.id}' canInviteWithoutGroups`,
    createError
  )
}

export function isInvitePolicyDefinition(value: unknown): value is InvitePolicyDefinition {
  try {
    assertInvitePolicyDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

export function validateSecurityDefinitionsAtStartup(input: {
  readonly groups: readonly GroupDefinition[]
  readonly invitePolicies: readonly InvitePolicyDefinition[]
}): RegisteredSecurityDefinitions {
  const groupsById = new Map<string, GroupDefinition>()
  const invitePoliciesById = new Map<string, InvitePolicyDefinition>()

  for (const group of input.groups) {
    assertGroupDefinition(group)

    if (groupsById.has(group.id)) {
      throw new SecurityValidationError(`Duplicate group id: ${group.id}`)
    }

    groupsById.set(group.id, group)
  }

  for (const policy of input.invitePolicies) {
    assertInvitePolicyDefinition(policy)

    if (invitePoliciesById.has(policy.id)) {
      throw new SecurityValidationError(`Duplicate invite policy id: ${policy.id}`)
    }

    if (policy.grantedToGroupIds.length === 0) {
      throw new SecurityValidationError(
        `Invite policy '${policy.id}' must grant invitation authority to at least one group.`
      )
    }

    if (policy.canInviteToGroupIds.length === 0 && policy.canInviteWithoutGroups !== true) {
      throw new SecurityValidationError(
        `Invite policy '${policy.id}' must declare canInviteTo groups or canInviteWithoutGroups.`
      )
    }

    assertNoDuplicateIds(policy.grantedToGroupIds, `Invite policy '${policy.id}' grantedTo`)
    assertNoDuplicateIds(policy.canInviteToGroupIds, `Invite policy '${policy.id}' canInviteTo`)

    for (const groupId of policy.grantedToGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `Invite policy '${policy.id}' grantedTo references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    for (const groupId of policy.canInviteToGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `Invite policy '${policy.id}' canInviteTo references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    invitePoliciesById.set(policy.id, policy)
  }

  return {
    groups: [...groupsById.values()],
    groupsById,
    invitePolicies: [...invitePoliciesById.values()],
    invitePoliciesById,
  }
}
