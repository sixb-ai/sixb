import { type ResolvedRole, resolveRoleGrants } from "../authorization"
import { APPLICATION_IDS } from "./applications"
import type {
  GroupDefinition,
  MembershipPolicyDefinition,
  RoleDefinition,
  SecurityRegistry,
} from "./types"
import { validateSecurityDefinitionsAtStartup } from "./validation"

class RuntimeSecurityRegistry implements SecurityRegistry {
  constructor(
    private readonly groupsById: ReadonlyMap<string, GroupDefinition>,
    private readonly rolesById: ReadonlyMap<string, RoleDefinition>,
    private readonly membershipPoliciesById: ReadonlyMap<string, MembershipPolicyDefinition>,
    private readonly resolvedRoles: readonly ResolvedRole[]
  ) {}

  listGroups(): readonly GroupDefinition[] {
    return [...this.groupsById.values()]
  }

  getGroupById(groupId: string): GroupDefinition | null {
    return this.groupsById.get(groupId) ?? null
  }

  listRoles(): readonly RoleDefinition[] {
    return [...this.rolesById.values()]
  }

  getRoleById(roleId: string): RoleDefinition | null {
    return this.rolesById.get(roleId) ?? null
  }

  listResolvedRoles(): readonly ResolvedRole[] {
    return this.resolvedRoles
  }

  listMembershipPolicies(): readonly MembershipPolicyDefinition[] {
    return [...this.membershipPoliciesById.values()]
  }

  getMembershipPolicyById(policyId: string): MembershipPolicyDefinition | null {
    return this.membershipPoliciesById.get(policyId) ?? null
  }
}

export function createRuntimeSecurityRegistry(input: {
  readonly groups?: readonly GroupDefinition[]
  readonly roles?: readonly RoleDefinition[]
  readonly membershipPolicies?: readonly MembershipPolicyDefinition[]
  readonly applicationIds?: ReadonlySet<string>
  readonly objectTypeIds?: ReadonlySet<string>
  readonly datasetIds?: ReadonlySet<string>
  readonly actionIds?: ReadonlySet<string>
  readonly workflowIds?: ReadonlySet<string>
  readonly syncIds?: ReadonlySet<string>
  readonly pipelineIds?: ReadonlySet<string>
  readonly agentIds?: ReadonlySet<string>
  readonly getSubTypes?: (objectTypeId: string) => readonly string[]
}): SecurityRegistry {
  const securityDefinitions = validateSecurityDefinitionsAtStartup({
    groups: input.groups ?? [],
    roles: input.roles ?? [],
    membershipPolicies: input.membershipPolicies ?? [],
    applicationIds: input.applicationIds ?? APPLICATION_IDS,
    objectTypeIds: input.objectTypeIds,
    datasetIds: input.datasetIds,
    actionIds: input.actionIds,
    workflowIds: input.workflowIds,
    syncIds: input.syncIds,
    pipelineIds: input.pipelineIds,
    agentIds: input.agentIds,
    observableIds: new Set(["logs"]),
  })

  const universe = {
    applicationIds: input.applicationIds ?? APPLICATION_IDS,
    objectTypeIds: input.objectTypeIds ?? new Set<string>(),
    datasetIds: input.datasetIds ?? new Set<string>(),
    actionIds: input.actionIds ?? new Set<string>(),
    workflowIds: input.workflowIds ?? new Set<string>(),
    syncIds: input.syncIds ?? new Set<string>(),
    pipelineIds: input.pipelineIds ?? new Set<string>(),
    agentIds: input.agentIds ?? new Set<string>(),
    observableIds: new Set(["logs"]),
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
    securityDefinitions.membershipPoliciesById,
    resolvedRoles
  )
}
