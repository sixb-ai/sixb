import {
  type AuthorizationContext,
  defineGroup,
  type GroupDefinition,
  type RoleDefinition,
  resolveAuthorizationContext,
  type SixbHost,
} from "../../src"

/** The groups these roles are granted to, declared as a host requires. */
export function groupsOf(roles: readonly RoleDefinition[]): readonly GroupDefinition[] {
  return [...new Set(roles.flatMap((role) => role.grantedToGroupIds))].map((id) => defineGroup(id))
}

/** The context a principal in these groups holds through the host's roles, as its session would. */
export function contextIn(
  host: SixbHost,
  groupIds: readonly string[],
  principal: AuthorizationContext["principal"] = { type: "user", id: "usr_reader" }
): AuthorizationContext {
  return resolveAuthorizationContext({
    principal,
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
}
