export interface GroupDefinition<TId extends string = string> {
  readonly kind: "group"
  readonly id: TId
  readonly label?: string
  readonly description?: string
}

export interface InvitePolicyDefinition<TId extends string = string> {
  readonly kind: "invitePolicy"
  readonly id: TId
  readonly grantedToGroupIds: readonly string[]
  readonly canInviteToGroupIds: readonly string[]
  readonly canInviteWithoutGroups?: boolean
}

export interface RegisteredSecurityDefinitions {
  readonly groups: readonly GroupDefinition[]
  readonly groupsById: ReadonlyMap<string, GroupDefinition>
  readonly invitePolicies: readonly InvitePolicyDefinition[]
  readonly invitePoliciesById: ReadonlyMap<string, InvitePolicyDefinition>
}

export interface SecurityRegistry {
  getGroupDefinitions(): readonly GroupDefinition[]
  getGroupById(groupId: string): GroupDefinition | null
  getInvitePolicyDefinitions(): readonly InvitePolicyDefinition[]
  getInvitePolicyById(policyId: string): InvitePolicyDefinition | null
}
