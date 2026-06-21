export type { DefineGroupOptions, DefineInvitePolicyOptions, DefineRoleOptions } from "./builders"
export { defineGroup, defineInvitePolicy, defineRole } from "./builders"
export { SecurityValidationError } from "./errors"
export { can } from "./grants"
export type { InvitePolicyScope } from "./invite-policies"
export {
  canInviteGroupIds,
  missingInviteGroupIds,
  resolveInvitePolicyScope,
} from "./invite-policies"
export type { Scope, ScopeTarget } from "./scopes"
export { actions, datasets, ontology, pipelines, syncs, workflows } from "./scopes"
export type {
  ApplyGrant,
  GrantCapability,
  GrantDefinition,
  GroupDefinition,
  InvitePolicyDefinition,
  RegisteredSecurityDefinitions,
  RoleDefinition,
  RunGrant,
  RunGrantTarget,
  SecurityRegistry,
  Selection,
  ViewGrant,
  ViewGrantTarget,
} from "./types"
export {
  assertGrantDefinition,
  assertGroupDefinition,
  assertInvitePolicyDefinition,
  assertRoleDefinition,
  isGroupDefinition,
  isInvitePolicyDefinition,
  isRoleDefinition,
  validateSecurityDefinitionsAtStartup,
} from "./validation"
