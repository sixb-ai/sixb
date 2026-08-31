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
type ProjectionAssertion = ProjectionSourceEntry["assertions"][number]
type ObjectAssertion = Extract<ProjectionAssertion, { readonly kind: "object" }>
type LinkAssertion = Extract<ProjectionAssertion, { readonly kind: "link" }>

interface ProjectionValidationPolicy {
  readonly expectedRootKind: ProjectionSourceEntry["root"]["kind"]
  readonly expectedRootDescription: string
  readonly ownedProperties: ReadonlyMap<string, ReadonlySet<string>>
  readonly ownedLinks: ReadonlySet<string>
}

export type ProjectionEntryValidator = (entry: ProjectionSourceEntry) => ProjectionSourceEntry

export function createProjectionEntryValidator(
  ontology: OntologyRegistry,
  resolved: ResolvedSourceProjection
): ProjectionEntryValidator {
  const policy = createValidationPolicy(resolved)
  return (entry) => validateProjectionEntry(ontology, resolved, policy, entry)
}

function createValidationPolicy(resolved: ResolvedSourceProjection): ProjectionValidationPolicy {
  const ownedProperties = new Map(
    resolved.ownership.objects.map((object) => [object.objectTypeId, new Set(object.propertyIds)])
  )
  const ownedLinks = new Set(
    resolved.ownership.links.map((link) => linkOwnershipKey(link.sourceObjectTypeId, link.linkId))
  )
  if (resolved.definition._tag === "ObjectProjectionDefinition") {
    return {
      expectedRootKind: "object",
      expectedRootDescription: "an object",
      ownedProperties,
      ownedLinks,
    }
  }
  return {
    expectedRootKind: "link",
    expectedRootDescription: "a link",
    ownedProperties,
    ownedLinks,
  }
}

function validateProjectionEntry(
  ontology: OntologyRegistry,
  resolved: ResolvedSourceProjection,
  policy: ProjectionValidationPolicy,
  entry: ProjectionSourceEntry
): ProjectionSourceEntry {
  validateProjectionRoot(resolved, policy, entry)
  return {
    root: entry.root,
    assertions: entry.assertions.map((assertion) =>
      validateProjectionAssertion(ontology, resolved, policy, assertion)
    ),
  }
}

function validateProjectionRoot(
  resolved: ResolvedSourceProjection,
  policy: ProjectionValidationPolicy,
  entry: ProjectionSourceEntry
): void {
  if (entry.root.kind === policy.expectedRootKind) return
  throw new MaterializationValidationError(
    `Projection '${resolved.projectionId}' requires ${policy.expectedRootDescription} root.`
  )
}

function validateProjectionAssertion(
  ontology: OntologyRegistry,
  resolved: ResolvedSourceProjection,
  policy: ProjectionValidationPolicy,
  assertion: ProjectionAssertion
): ProjectionAssertion {
  if (assertion.kind === "object") {
    return validateObjectAssertion(ontology, resolved, policy, assertion)
  }
  return validateLinkAssertion(ontology, resolved, policy, assertion)
}

function validateObjectAssertion(
  ontology: OntologyRegistry,
  resolved: ResolvedSourceProjection,
  policy: ProjectionValidationPolicy,
  assertion: ObjectAssertion
): ObjectAssertion {
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
  const owned = policy.ownedProperties.get(assertion.ref.objectTypeId) ?? new Set<string>()
  for (const propertyId of Object.keys(properties)) {
    if (owned.has(propertyId)) continue
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' asserted unowned property '${assertion.ref.objectTypeId}.${propertyId}'.`
    )
  }
  const conflictResolution = resolved.definition.conflictResolution ?? { strategy: "editsWin" }
  if (conflictResolution.strategy !== "mostRecent") {
    return { kind: "object", ref: assertion.ref, properties }
  }
  if (assertion.sourceUpdatedAt === undefined) {
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' requires source update timestamp ` +
        `'${conflictResolution.sourceTimestamp}' on every object assertion.`
    )
  }
  const primaryPropertyId = ontology.getPrimaryPropertyId(assertion.ref.objectTypeId)
  const absentSourcePropertyIds = [...owned]
    .filter(
      (propertyId) => propertyId !== primaryPropertyId && !Object.hasOwn(properties, propertyId)
    )
    .sort()
  return {
    kind: "object",
    ref: assertion.ref,
    properties,
    sourceUpdatedAt: assertion.sourceUpdatedAt,
    ...(absentSourcePropertyIds.length === 0 ? {} : { absentSourcePropertyIds }),
  }
}

function validateLinkAssertion(
  ontology: OntologyRegistry,
  resolved: ResolvedSourceProjection,
  policy: ProjectionValidationPolicy,
  assertion: LinkAssertion
): LinkAssertion {
  const ownershipKey = linkOwnershipKey(assertion.ref.source.objectTypeId, assertion.ref.linkId)
  if (!policy.ownedLinks.has(ownershipKey)) {
    throw new MaterializationValidationError("Projection asserted a link outside its owned scope.")
  }

  const expectedTargetTypeId = projectionLinkTargetType(resolved, assertion)
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
}

function projectionLinkTargetType(
  resolved: ResolvedSourceProjection,
  assertion: LinkAssertion
): string | undefined {
  if (resolved.definition._tag === "LinkProjectionDefinition") {
    return resolved.definition.targetObjectTypeId
  }
  if (resolved.definition._tag === "ObjectProjectionDefinition") {
    return resolved.definition.links[assertion.ref.linkId]?.targetObjectTypeId
  }
  return undefined
}
