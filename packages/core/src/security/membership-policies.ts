import type { MembershipOperation, MembershipPolicyDefinition } from "./types"

export interface MembershipOperationScope {
  readonly policyIds: readonly string[]
  readonly groupIds: ReadonlySet<string>
}

export interface MembershipPolicyScope {
  readonly policyIds: readonly string[]
  readonly operations: Readonly<Record<MembershipOperation, MembershipOperationScope>>
}

const MEMBERSHIP_OPERATIONS = ["invite", "assignGroups", "suspend"] as const

export function resolveMembershipPolicyScope(input: {
  readonly membershipPolicies: readonly MembershipPolicyDefinition[]
  readonly callerGroupIds: readonly string[]
}): MembershipPolicyScope {
  const callerGroups = new Set(input.callerGroupIds)
  const policyIds: string[] = []
  const operations = createEmptyOperationScopes()

  for (const policy of input.membershipPolicies) {
    if (!policy.grantedToGroupIds.some((groupId) => callerGroups.has(groupId))) {
      continue
    }

    policyIds.push(policy.id)
    for (const operation of policy.can) {
      operations[operation].policyIds.push(policy.id)
      for (const groupId of policy.scopeGroupIds) {
        operations[operation].groupIds.add(groupId)
      }
    }
  }

  return {
    policyIds,
    operations: {
      invite: freezeOperationScope(operations.invite),
      assignGroups: freezeOperationScope(operations.assignGroups),
      suspend: freezeOperationScope(operations.suspend),
    },
  }
}

export function canPerformMembershipOperation(
  scope: MembershipPolicyScope,
  operation: MembershipOperation,
  groupIds: readonly string[]
): boolean {
  const operationScope = scope.operations[operation]

  if (operationScope.policyIds.length === 0) {
    return false
  }

  if (groupIds.length === 0) {
    return true
  }

  return groupIds.every((groupId) => operationScope.groupIds.has(groupId))
}

export function missingMembershipGroupIds(
  scope: MembershipPolicyScope,
  operation: MembershipOperation,
  groupIds: readonly string[]
): readonly string[] {
  if (groupIds.length === 0) {
    return []
  }

  const operationScope = scope.operations[operation]
  return groupIds.filter((groupId) => !operationScope.groupIds.has(groupId))
}

function createEmptyOperationScopes(): Record<
  MembershipOperation,
  { policyIds: string[]; groupIds: Set<string> }
> {
  return {
    invite: { policyIds: [], groupIds: new Set<string>() },
    assignGroups: { policyIds: [], groupIds: new Set<string>() },
    suspend: { policyIds: [], groupIds: new Set<string>() },
  }
}

function freezeOperationScope(input: {
  readonly policyIds: readonly string[]
  readonly groupIds: ReadonlySet<string>
}): MembershipOperationScope {
  return {
    policyIds: [...input.policyIds],
    groupIds: new Set(input.groupIds),
  }
}

export function isMembershipOperation(value: unknown): value is MembershipOperation {
  return MEMBERSHIP_OPERATIONS.includes(value as MembershipOperation)
}
