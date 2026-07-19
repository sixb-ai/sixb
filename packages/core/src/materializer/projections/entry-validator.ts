import { MaterializationValidationError } from "../../materialization/errors"
import type { ProjectionSourceEntry } from "../../materialization/model"
import { linkOwnershipKey } from "../../materialization/refs"
import type { OntologyRegistry } from "../../ontology"
import type { ProjectionRegistry } from "../../projections/registry"
import {
  validateLinkAuthorityProperties,
  validateObjectAuthorityProperties,
} from "../effective/validate"

type ResolvedSourceProjection = ReturnType<ProjectionRegistry["resolveSource"]>

export type ProjectionEntryValidator = (entry: ProjectionSourceEntry) => ProjectionSourceEntry

export function createProjectionEntryValidator(
  ontology: OntologyRegistry,
  resolved: ResolvedSourceProjection
): ProjectionEntryValidator {
  const expectedRootKind =
    resolved.definition._tag === "ObjectProjectionDefinition" ? "object" : "link"
  const ownedProperties = new Map(
    resolved.ownership.objects.map((object) => [object.objectTypeId, new Set(object.propertyIds)])
  )
  const ownedLinks = new Set(
    resolved.ownership.links.map((link) => linkOwnershipKey(link.sourceObjectTypeId, link.linkId))
  )

  return (entry) => {
    if (entry.root.kind !== expectedRootKind) {
      throw new MaterializationValidationError(
        `Projection '${resolved.projectionId}' requires ${expectedRootKind === "object" ? "an object" : "a link"} root.`
      )
    }
    const assertions = entry.assertions.map((assertion) => {
      if (assertion.kind === "object") {
        if (
          resolved.definition._tag !== "ObjectProjectionDefinition" ||
          assertion.ref.objectTypeId !== resolved.definition.objectTypeId
        ) {
          throw new MaterializationValidationError(
            "Projection asserted an object outside its owned type."
          )
        }
        const properties = validateObjectAuthorityProperties(
          ontology,
          assertion.ref,
          assertion.properties
        )
        const owned = ownedProperties.get(assertion.ref.objectTypeId) ?? new Set<string>()
        for (const propertyId of Object.keys(properties)) {
          if (!owned.has(propertyId)) {
            throw new MaterializationValidationError(
              `Projection '${resolved.projectionId}' asserted unowned property '${assertion.ref.objectTypeId}.${propertyId}'.`
            )
          }
        }
        return { ...assertion, properties }
      }

      if (
        !ownedLinks.has(linkOwnershipKey(assertion.ref.source.objectTypeId, assertion.ref.linkId))
      ) {
        throw new MaterializationValidationError(
          "Projection asserted a link outside its owned scope."
        )
      }
      const expectedTargetTypeId =
        resolved.definition._tag === "LinkProjectionDefinition"
          ? resolved.definition.targetObjectTypeId
          : resolved.definition.links[assertion.ref.linkId]?.targetObjectTypeId
      if (expectedTargetTypeId !== assertion.ref.target.objectTypeId) {
        throw new MaterializationValidationError(
          `Projection '${resolved.projectionId}' asserted link target type '${assertion.ref.target.objectTypeId}' outside its mapping.`
        )
      }
      validateLinkAuthorityProperties(ontology, assertion.ref, assertion.properties)
      if (assertion.properties !== undefined) {
        throw new MaterializationValidationError(
          `Projection '${resolved.projectionId}' does not map link assertion properties.`
        )
      }
      return { ...assertion }
    })
    return { root: entry.root, assertions }
  }
}
