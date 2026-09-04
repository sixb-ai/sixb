import { GRANT_KINDS, type GrantUniverseKey, grantKindOf } from "../authorization/grant-kinds"
import { SecurityValidationError } from "./errors"
import { isMembershipOperation } from "./membership-policies"
import type {
  GrantCapability,
  GrantDefinition,
  GroupDefinition,
  MembershipPolicyDefinition,
  RegisteredSecurityDefinitions,
  RoleDefinition,
} from "./types"

/** Registered id universes keyed as the grant-kind table expects them. */
type RegisteredUniverses = Partial<Record<GrantUniverseKey, ReadonlySet<string>>>

/**
 * Every grant capability, for validating grants that arrive from untyped code.
 *
 * Written as a total `Record<GrantCapability, true>` rather than a bare array so a capability added
 * to `GrantDefinition` is a compile error here — the same discipline `GRANT_KINDS` uses. The
 * hand-written `capability !== "access" && …` chain this replaces would have accepted the new
 * capability at startup and then died on `GRANT_KINDS[kind].universeKey`.
 */
const GRANT_CAPABILITIES = Object.keys({
  access: true,
  view: true,
  edit: true,
  append: true,
  apply: true,
  run: true,
  observe: true,
  manage: true,
} satisfies Record<GrantCapability, true>) as readonly GrantCapability[]

/** "'a', 'b', or 'c'" — the shape the security errors already use. */
function formatAlternatives(values: readonly string[]): string {
  const quoted = values.map((value) => `'${value}'`)
  const last = quoted.at(-1)
  return quoted.length < 2 ? (last ?? "") : `${quoted.slice(0, -1).join(", ")}, or ${last}`
}

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

function assertMembershipOperationArray(
  value: unknown,
  field: string,
  createError: CreateSecurityError
): asserts value is MembershipPolicyDefinition["can"] {
  if (!Array.isArray(value)) {
    throw createError(`[Sixb] ${field} must be an array of membership operations.`)
  }

  for (const item of value) {
    if (!isMembershipOperation(item)) {
      throw createError(
        `[Sixb] ${field} must contain only membership operations: invite, assignGroups, suspend.`
      )
    }
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

function assertNoDuplicateOperations(
  operations: readonly MembershipPolicyDefinition["can"][number][],
  field: string
): void {
  const seen = new Set<string>()
  for (const operation of operations) {
    if (seen.has(operation)) {
      throw new SecurityValidationError(
        `[Sixb] ${field} contains duplicate operation '${operation}'.`
      )
    }
    seen.add(operation)
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

export function assertMembershipPolicyDefinition(
  value: unknown,
  createError: CreateSecurityError = (message) => new SecurityValidationError(message)
): asserts value is MembershipPolicyDefinition {
  if (!isRecord(value)) {
    throw createError("[Sixb] Membership policy definition must be an object.")
  }

  if (value.kind !== "membershipPolicy") {
    throw createError("[Sixb] Membership policy definition kind must be 'membershipPolicy'.")
  }

  assertNonEmptyString(value.id, "Membership policy id", createError)
  assertStringArray(
    value.grantedToGroupIds,
    `Membership policy '${value.id}' grantedTo`,
    createError
  )
  assertStringArray(value.scopeGroupIds, `Membership policy '${value.id}' scope`, createError)
  assertMembershipOperationArray(value.can, `Membership policy '${value.id}' can`, createError)
}

export function isMembershipPolicyDefinition(value: unknown): value is MembershipPolicyDefinition {
  try {
    assertMembershipPolicyDefinition(value, (message) => new Error(message))
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

  if (!GRANT_CAPABILITIES.includes(value.capability as GrantCapability)) {
    throw createError(
      `[Sixb] ${field} grant capability must be ${formatAlternatives(GRANT_CAPABILITIES)}.`
    )
  }

  if (value.capability === "access" && value.target !== "application") {
    throw createError(`[Sixb] ${field} access grant target must be 'application'.`)
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

  if (value.capability === "observe" && value.target !== "logs" && value.target !== "aiUsage") {
    throw createError(`[Sixb] ${field} observe grant target must be 'logs' or 'aiUsage'.`)
  }

  if (value.capability === "manage" && value.target !== "connector" && value.target !== "aiUsage") {
    throw createError(`[Sixb] ${field} manage grant target must be 'connector' or 'aiUsage'.`)
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
  readonly membershipPolicies: readonly MembershipPolicyDefinition[]
  readonly roles?: readonly RoleDefinition[]
  /** Registered browser application ids — when provided, access grants must reference them. */
  readonly applicationIds?: ReadonlySet<string>
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
  /** Registered observability surfaces. */
  readonly observableIds?: ReadonlySet<string>
  /** Registered singleton management surfaces. */
  readonly manageableIds?: ReadonlySet<string>
  /** Registered connector ids — when provided, manage grants must reference them. */
  readonly connectorIds?: ReadonlySet<string>
}): RegisteredSecurityDefinitions {
  const groupsById = new Map<string, GroupDefinition>()
  const rolesById = new Map<string, RoleDefinition>()
  const membershipPoliciesById = new Map<string, MembershipPolicyDefinition>()

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

  for (const policy of input.membershipPolicies) {
    assertMembershipPolicyDefinition(policy)

    if (membershipPoliciesById.has(policy.id)) {
      throw new SecurityValidationError(`[Sixb] Duplicate membership policy id: ${policy.id}`)
    }

    if (policy.grantedToGroupIds.length === 0) {
      throw new SecurityValidationError(
        `[Sixb] Membership policy '${policy.id}' must grant membership authority to at least one group.`
      )
    }

    if (policy.can.length === 0) {
      throw new SecurityValidationError(
        `[Sixb] Membership policy '${policy.id}' must declare at least one operation.`
      )
    }

    assertNoDuplicateIds(policy.grantedToGroupIds, `Membership policy '${policy.id}' grantedTo`)
    assertNoDuplicateIds(policy.scopeGroupIds, `Membership policy '${policy.id}' scope`)
    assertNoDuplicateOperations(policy.can, `Membership policy '${policy.id}' can`)

    for (const groupId of policy.grantedToGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `[Sixb] Membership policy '${policy.id}' grantedTo references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    for (const groupId of policy.scopeGroupIds) {
      if (!groupsById.has(groupId)) {
        throw new SecurityValidationError(
          `[Sixb] Membership policy '${policy.id}' scope references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    membershipPoliciesById.set(policy.id, policy)
  }

  return {
    groups: [...groupsById.values()],
    groupsById,
    roles: [...rolesById.values()],
    rolesById,
    membershipPolicies: [...membershipPoliciesById.values()],
    membershipPoliciesById,
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
