import type { AuthSessionAudience } from "../auth/audience"
import type { ResolvedRole } from "../authorization/types"

export interface GroupDefinition<TId extends string = string> {
  readonly kind: "group"
  readonly id: TId
  readonly label?: string
  readonly description?: string
}

/**
 * A capability's reach over its target's id space. Either the whole registered
 * universe minus an exclusion list (`every.object().except([...])`) or an
 * explicit set of ids (`can.view([A, B])`). Both forms expand to a concrete set
 * of ids at startup, so the resolved index only ever holds plain `Set`s.
 */
export type Selection =
  | { readonly all: true; readonly except: readonly string[] }
  | { readonly all: false; readonly ids: readonly string[] }

export interface ApplicationDefinition<TId extends AuthSessionAudience = AuthSessionAudience> {
  readonly kind: "application"
  readonly id: TId
  readonly label: string
}

export interface AccessGrant {
  readonly kind: "grant"
  readonly capability: "access"
  readonly target: "application"
  readonly selection: Selection
}

export type ViewGrantTarget = "object" | "dataset"

export interface ViewGrant<TTarget extends ViewGrantTarget = ViewGrantTarget> {
  readonly kind: "grant"
  readonly capability: "view"
  readonly target: TTarget
  readonly selection: Selection
}

export interface ApplyGrant {
  readonly kind: "grant"
  readonly capability: "apply"
  readonly selection: Selection
}

export type RunGrantTarget = "workflow" | "sync" | "pipeline" | "agent"

export interface RunGrant<TTarget extends RunGrantTarget = RunGrantTarget> {
  readonly kind: "grant"
  readonly capability: "run"
  readonly target: TTarget
  readonly selection: Selection
}

export type ObserveGrantTarget = "logs"

export interface ObserveGrant {
  readonly kind: "grant"
  readonly capability: "observe"
  readonly target: ObserveGrantTarget
  readonly selection: Selection
}

export type GrantDefinition = AccessGrant | ViewGrant | ApplyGrant | RunGrant | ObserveGrant

export type GrantCapability = GrantDefinition["capability"]

export interface RoleDefinition<TId extends string = string> {
  readonly kind: "role"
  readonly id: TId
  readonly label?: string
  readonly description?: string
  readonly grantedToGroupIds: readonly string[]
  readonly grants: readonly GrantDefinition[]
}

export type MembershipOperation = "invite" | "assignGroups" | "suspend"

export interface MembershipPolicyDefinition<TId extends string = string> {
  readonly kind: "membershipPolicy"
  readonly id: TId
  readonly grantedToGroupIds: readonly string[]
  readonly scopeGroupIds: readonly string[]
  readonly can: readonly MembershipOperation[]
}

export interface RegisteredSecurityDefinitions {
  readonly groups: readonly GroupDefinition[]
  readonly groupsById: ReadonlyMap<string, GroupDefinition>
  readonly roles: readonly RoleDefinition[]
  readonly rolesById: ReadonlyMap<string, RoleDefinition>
  readonly membershipPolicies: readonly MembershipPolicyDefinition[]
  readonly membershipPoliciesById: ReadonlyMap<string, MembershipPolicyDefinition>
}

export interface SecurityRegistry {
  getGroupDefinitions(): readonly GroupDefinition[]
  getGroupById(groupId: string): GroupDefinition | null
  getRoleDefinitions(): readonly RoleDefinition[]
  getRoleById(roleId: string): RoleDefinition | null
  /** Roles with their grants pre-expanded to concrete id sets for resolution. */
  getResolvedRoles(): readonly ResolvedRole[]
  getMembershipPolicyDefinitions(): readonly MembershipPolicyDefinition[]
  getMembershipPolicyById(policyId: string): MembershipPolicyDefinition | null
}
