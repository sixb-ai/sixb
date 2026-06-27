import { GRANT_KINDS, type GrantUniverseKey, grantKindOf } from "../authorization/grant-kinds"
import { SecurityValidationError } from "./errors"
import type {
  GrantDefinition,
  GroupDefinition,
  InvitePolicyDefinition,
  RegisteredSecurityDefinitions,
  RoleDefinition,
} from "./types"

/** Registered id universes keyed as the grant-kind table expects them. */
type RegisteredUniverses = Partial<Record<GrantUniverseKey, ReadonlySet<string>>>

export type CreateSecurityError = (message: string) => Error

// Shared, single-source validation primitives. The builders reuse these too, so
// authoring-time and startup-time checks can never drift apart.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertNonEmptyString(
  value: unknown,
  field: string,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createError(`[Sixb] ${field} must not be empty.`)
  }
}

export function assertOptionalString(
  value: unknown,
  field: string,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is string | undefined {
  if (value === undefined) {
    return
  }

  if (typeof value !== "string") {
    throw createError(`[Sixb] ${field} must be a string.`)
  }
}

function assertStringArray(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw createError(`[Sixb] ${field} must be an array of group ids.`)
  }

  for (const item of value) {
    assertNonEmptyString(item, `${field} item`, createError)
  }
}

export function assertOptionalBoolean(
  value: unknown,
  field: string,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is boolean | undefined {
  if (value === undefined) {
    return
  }

  if (typeof value !== "boolean") {
    throw createError(`[Sixb] ${field} must be a boolean.`)
  }
}

function assertNoDuplicateIds(ids: readonly string[], field: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new SecurityValidationError(`[Sixb] ${field} contains duplicate group id '${id}'.`)
    }
    seen.add(id)
  }
}

export function assertGroupDefinition(
  value: unknown,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is GroupDefinition {
  if (!isRecord(value)) {
    throw createError("[Sixb] Group definition must be an object.")
  }

  if (value.kind !== "group") {
    throw createError("[Sixb] Group definition kind must be 'group'.")
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
    throw createError("[Sixb] Invite policy definition must be an object.")
  }

  if (value.kind !== "invitePolicy") {
    throw createError("[Sixb] Invite policy definition kind must be 'invitePolicy'.")
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

export function assertGrantDefinition(
  value: unknown,
  field: string,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is GrantDefinition {
  if (!isRecord(value) || value.kind !== "grant") {
    throw createError(`[Sixb] ${field} must contain only grant definitions from 'can'.`)
  }

  if (value.capability !== "view" && value.capability !== "apply" && value.capability !== "run") {
    throw createError(`[Sixb] ${field} grant capability must be 'view', 'apply', or 'run'.`)
  }

  if (value.capability === "view" && value.target !== "object" && value.target !== "dataset") {
    throw createError(`[Sixb] ${field} view grant target must be 'object' or 'dataset'.`)
  }

  if (
    value.capability === "run" &&
    value.target !== "workflow" &&
    value.target !== "sync" &&
    value.target !== "pipeline" &&
    value.target !== "agent"
  ) {
    throw createError(
      `[Sixb] ${field} run grant target must be 'workflow', 'sync', 'pipeline', or 'agent'.`
    )
  }

  assertSelection(value.selection, field, createError)
}

function assertSelection(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is GrantDefinition["selection"] {
  if (!isRecord(value) || typeof value.all !== "boolean") {
    throw createError(`[Sixb] ${field} grant must carry a selection from 'can' or a scope.`)
  }

  const ids = value.all ? value.except : value.ids
  if (!Array.isArray(ids)) {
    throw createError(`[Sixb] ${field} grant selection must list ids.`)
  }

  for (const id of ids) {
    assertNonEmptyString(id, `${field} grant selection id`, createError)
  }
}

export function assertRoleDefinition(
  value: unknown,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is RoleDefinition {
  if (!isRecord(value)) {
    throw createError("[Sixb] Role definition must be an object.")
  }

  if (value.kind !== "role") {
    throw createError("[Sixb] Role definition kind must be 'role'.")
  }

  assertNonEmptyString(value.id, "Role id", createError)
  assertOptionalString(value.label, `Role '${value.id}' label`, createError)
  assertOptionalString(value.description, `Role '${value.id}' description`, createError)
  assertStringArray(value.grantedToGroupIds, `Role '${value.id}' grantedTo`, createError)

  if (!Array.isArray(value.grants)) {
    throw createError(`[Sixb] Role '${value.id}' grants must be an array.`)
  }

  for (const grant of value.grants) {
    assertGrantDefinition(grant, `Role '${value.id}' grants`, createError)
  }
}

export function isRoleDefinition(value: unknown): value is RoleDefinition {
  try {
    assertRoleDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

export function validateSecurityDefinitionsAtStartup(input: {
  readonly groups: readonly GroupDefinition[]
  readonly invitePolicies: readonly InvitePolicyDefinition[]
  readonly roles?: readonly RoleDefinition[]
  /** Registered object type ids — when provided, view grants must reference them. */
  readonly objectTypeIds?: ReadonlySet<string>
  /** Registered dataset ids — when provided, dataset view grants must reference them. */
  readonly datasetIds?: ReadonlySet<string>
  /** Registered action ids — when provided, apply grants must reference them. */
  readonly actionIds?: ReadonlySet<string>
  /** Registered workflow ids — when provided, run grants must reference them. */
  readonly workflowIds?: ReadonlySet<string>
  /** Registered sync ids — when provided, sync run grants must reference them. */
  readonly syncIds?: ReadonlySet<string>
  /** Registered pipeline ids — when provided, pipeline run grants must reference them. */
  readonly pipelineIds?: ReadonlySet<string>
  /** Registered agent ids — when provided, agent run grants must reference them. */
  readonly agentIds?: ReadonlySet<string>
}): RegisteredSecurityDefinitions {
  const groupsById = new Map<string, GroupDefinition>()
  const rolesById = new Map<string, RoleDefinition>()
  const invitePoliciesById = new Map<string, InvitePolicyDefinition>()

  for (const group of input.groups) {
    assertGroupDefinition(group)

    if (groupsById.has(group.id)) {
      throw new SecurityValidationError(`[Sixb] Duplicate group id: ${group.id}`)
    }

    groupsById.set(group.id, group)
  }

  for (const role of input.roles ?? []) {
    assertRoleDefinition(role)

    if (rolesById.has(role.id)) {
      throw new SecurityValidationError(`[Sixb] Duplicate role id: ${role.id}`)
    }

    if (role.grantedToGroupIds.length === 0) {
      throw new SecurityValidationError(
        `[Sixb] Role '${role.id}' must be granted to at least one group.`
      )
    }

    if (role.grants.length === 0) {
      throw new SecurityValidationError(`[Sixb] Role '${role.id}' must declare at least one grant.`)
    }

    assertNoDuplicateIds(role.grantedToGroupIds, `Role '${role.id}' grantedTo`)

    for (const groupId of role.grantedToGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `[Sixb] Role '${role.id}' grantedTo references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    for (const grant of role.grants) {
      assertGrantReferences(role.id, grant, input)
    }

    rolesById.set(role.id, role)
  }

  for (const policy of input.invitePolicies) {
    assertInvitePolicyDefinition(policy)

    if (invitePoliciesById.has(policy.id)) {
      throw new SecurityValidationError(`[Sixb] Duplicate invite policy id: ${policy.id}`)
    }

    if (policy.grantedToGroupIds.length === 0) {
      throw new SecurityValidationError(
        `[Sixb] Invite policy '${policy.id}' must grant invitation authority to at least one group.`
      )
    }

    if (policy.canInviteToGroupIds.length === 0 && policy.canInviteWithoutGroups !== true) {
      throw new SecurityValidationError(
        `[Sixb] Invite policy '${policy.id}' must declare canInviteTo groups or canInviteWithoutGroups.`
      )
    }

    assertNoDuplicateIds(policy.grantedToGroupIds, `Invite policy '${policy.id}' grantedTo`)
    assertNoDuplicateIds(policy.canInviteToGroupIds, `Invite policy '${policy.id}' canInviteTo`)

    for (const groupId of policy.grantedToGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `[Sixb] Invite policy '${policy.id}' grantedTo references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    for (const groupId of policy.canInviteToGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `[Sixb] Invite policy '${policy.id}' canInviteTo references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    invitePoliciesById.set(policy.id, policy)
  }

  return {
    groups: [...groupsById.values()],
    groupsById,
    roles: [...rolesById.values()],
    rolesById,
    invitePolicies: [...invitePoliciesById.values()],
    invitePoliciesById,
  }
}

function assertGrantReferences(
  roleId: string,
  grant: GrantDefinition,
  registered: RegisteredUniverses
): void {
  const spec = GRANT_KINDS[grantKindOf(grant)]
  const universe = registered[spec.universeKey]

  if (!universe) {
    return
  }

  // Explicit selections list ids to include; "all except" selections list ids
  // to exclude. Either way every named id must be registered — an unknown id is
  // a typo that would silently widen or no-op the grant.
  const ids = grant.selection.all ? grant.selection.except : grant.selection.ids

  for (const id of ids) {
    if (!universe.has(id)) {
      throw new SecurityValidationError(
        `[Sixb] Role '${roleId}' grants ${grant.capability} on unknown ${spec.subject} '${id}'. ${spec.fix}`
      )
    }
  }
}
