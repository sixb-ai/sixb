import type { InvitePolicyDefinition } from "./types"

export interface InvitePolicyScope {
  readonly policyIds: readonly string[]
  readonly canInviteToGroupIds: ReadonlySet<string>
  readonly canInviteWithoutGroups: boolean
}

export function resolveInvitePolicyScope(input: {
  readonly invitePolicies: readonly InvitePolicyDefinition[]
  readonly callerGroupIds: readonly string[]
}): InvitePolicyScope {
  const callerGroups = new Set(input.callerGroupIds)
  const policyIds: string[] = []
  const canInviteToGroupIds = new Set<string>()
  let canInviteWithoutGroups = false

  for (const policy of input.invitePolicies) {
    if (!policy.grantedToGroupIds.some((groupId) => callerGroups.has(groupId))) {
      continue
    }

    policyIds.push(policy.id)
    for (const groupId of policy.canInviteToGroupIds) {
      canInviteToGroupIds.add(groupId)
    }
    canInviteWithoutGroups = canInviteWithoutGroups || policy.canInviteWithoutGroups === true
  }

  return {
    policyIds,
    canInviteToGroupIds,
    canInviteWithoutGroups,
  }
}

export function canInviteGroupIds(scope: InvitePolicyScope, groupIds: readonly string[]): boolean {
  if (groupIds.length === 0) {
    return scope.canInviteWithoutGroups
  }

  return groupIds.every((groupId) => scope.canInviteToGroupIds.has(groupId))
}

export function missingInviteGroupIds(
  scope: InvitePolicyScope,
  groupIds: readonly string[]
): readonly string[] {
  if (groupIds.length === 0) {
    return []
  }

  return groupIds.filter((groupId) => !scope.canInviteToGroupIds.has(groupId))
}
