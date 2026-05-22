import type { GroupDefinition, InvitePolicyDefinition, SecurityRegistry } from "./types"
import { validateSecurityDefinitionsAtStartup } from "./validation"

class RuntimeSecurityRegistry implements SecurityRegistry {
  constructor(
    private readonly groupsById: ReadonlyMap<string, GroupDefinition>,
    private readonly invitePoliciesById: ReadonlyMap<string, InvitePolicyDefinition>
  ) {}

  getGroupDefinitions(): readonly GroupDefinition[] {
    return [...this.groupsById.values()]
  }

  getGroupById(groupId: string): GroupDefinition | null {
    return this.groupsById.get(groupId) ?? null
  }

  getInvitePolicyDefinitions(): readonly InvitePolicyDefinition[] {
    return [...this.invitePoliciesById.values()]
  }

  getInvitePolicyById(policyId: string): InvitePolicyDefinition | null {
    return this.invitePoliciesById.get(policyId) ?? null
  }
}

export function createRuntimeSecurityRegistry(input: {
  readonly groups?: readonly GroupDefinition[]
  readonly invitePolicies?: readonly InvitePolicyDefinition[]
}): SecurityRegistry {
  const securityDefinitions = validateSecurityDefinitionsAtStartup({
    groups: input.groups ?? [],
    invitePolicies: input.invitePolicies ?? [],
  })

  return new RuntimeSecurityRegistry(
    securityDefinitions.groupsById,
    securityDefinitions.invitePoliciesById
  )
}
