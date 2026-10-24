import {
  type AuthorizationContext,
  defineGroup,
  type OntologySource,
  type RoleDefinition,
} from "../../src"
import { resolveAuthorizationContext } from "../../src/authorization"
import { OntologyRegistry } from "../../src/ontology"
import { SecurityRegistry } from "../../src/security/registry"

/**
 * Resolve roles that may hold `can.view(Type).where(...)` as startup does, short of the refusal a
 * host still applies to every condition.
 */
export function resolveRolesWithConditions(input: {
  readonly ontology: readonly OntologySource[]
  readonly roles: readonly RoleDefinition[]
}) {
  const ontology = new OntologyRegistry({ sources: input.ontology })
  const security = new SecurityRegistry({
    roles: input.roles,
    groups: [...new Set(input.roles.flatMap((role) => role.grantedToGroupIds))].map((id) =>
      defineGroup(id)
    ),
    objectTypeIds: new Set(ontology.listObjectTypes().map((objectType) => objectType.id)),
    getSubTypes: (objectTypeId) => ontology.listSubTypes(objectTypeId),
    ontology,
  })

  return {
    ontology,
    security,
    contextFor(
      groupIds: readonly string[],
      principal: AuthorizationContext["principal"] = { type: "user", id: "usr_reader" }
    ): AuthorizationContext {
      return resolveAuthorizationContext({
        principal,
        groupIds,
        roles: security.listResolvedRoles(),
      })
    },
  }
}
