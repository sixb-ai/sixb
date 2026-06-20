import { type ResolvedRole, resolveRoleGrants } from "../authorization"
import type {
  GroupDefinition,
  InvitePolicyDefinition,
  RoleDefinition,
  SecurityRegistry,
} from "./types"
import { validateSecurityDefinitionsAtStartup } from "./validation"

class RuntimeSecurityRegistry implements SecurityRegistry {
  constructor(
    private readonly groupsById: ReadonlyMap<string, GroupDefinition>,
    private readonly rolesById: ReadonlyMap<string, RoleDefinition>,
    private readonly invitePoliciesById: ReadonlyMap<string, InvitePolicyDefinition>,
    private readonly resolvedRoles: readonly ResolvedRole[]
  ) {}

  getGroupDefinitions(): readonly GroupDefinition[] {
    return [...this.groupsById.values()]
  }

  getGroupById(groupId: string): GroupDefinition | null {
    return this.groupsById.get(groupId) ?? null
  }

  getRoleDefinitions(): readonly RoleDefinition[] {
    return [...this.rolesById.values()]
  }

  getRoleById(roleId: string): RoleDefinition | null {
    return this.rolesById.get(roleId) ?? null
  }

  getResolvedRoles(): readonly ResolvedRole[] {
    return this.resolvedRoles
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
  readonly roles?: readonly RoleDefinition[]
  readonly invitePolicies?: readonly InvitePolicyDefinition[]
  readonly objectTypeIds?: ReadonlySet<string>
  readonly actionIds?: ReadonlySet<string>
  readonly workflowIds?: ReadonlySet<string>
  readonly getSubTypes?: (objectTypeId: string) => readonly string[]
}): SecurityRegistry {
  const securityDefinitions = validateSecurityDefinitionsAtStartup({
    groups: input.groups ?? [],
    roles: input.roles ?? [],
    invitePolicies: input.invitePolicies ?? [],
    objectTypeIds: input.objectTypeIds,
    actionIds: input.actionIds,
    workflowIds: input.workflowIds,
  })

  const universe = {
    objectTypeIds: input.objectTypeIds ?? new Set<string>(),
    actionIds: input.actionIds ?? new Set<string>(),
    workflowIds: input.workflowIds ?? new Set<string>(),
    getSubTypes: input.getSubTypes ?? (() => []),
  }
  const resolvedRoles = securityDefinitions.roles.map((role) => ({
    id: role.id,
    grantedToGroupIds: role.grantedToGroupIds,
    grants: resolveRoleGrants(role, universe),
  }))

  return new RuntimeSecurityRegistry(
    securityDefinitions.groupsById,
    securityDefinitions.rolesById,
    securityDefinitions.invitePoliciesById,
    resolvedRoles
  )
}
