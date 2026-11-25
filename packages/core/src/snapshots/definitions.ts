import { sha256Canonical } from "../materialization/identity"
import { vectorConfiguration } from "../objects/vectors/profile"
import type { OntologyDefinitionCatalog, OntologyRegistry } from "../ontology/registry"
import type { ObjectLink, ObjectType, Property, ValueType } from "../ontology/types"
import type { UniqueValueKind } from "../ontology/unique-values"
import { computeOntologyRevision } from "../projections/revision"
import type { SnapshotTypeManifest } from "./format"

/** What the manifest records of a type's definition, for {@link checkTypeFits} to compare. */
export type TypeDefinitionManifest = Pick<
  SnapshotTypeManifest,
  "primaryPropertyId" | "properties" | "requiredPropertyIds" | "uniquePropertyIds" | "links"
>

export function typeDefinitionManifest(
  objectType: ObjectType,
  ontology: OntologyDefinitionCatalog
): TypeDefinitionManifest {
  const valueTypes = ontology.getValueTypesById()

  return {
    primaryPropertyId: ontology.getPrimaryPropertyId(objectType.id),
    properties: Object.fromEntries(
      objectType.properties.map((property) => [
        property.id,
        propertyFingerprint(property, valueTypes),
      ])
    ),
    requiredPropertyIds: objectType.properties.filter((p) => p.required).map((p) => p.id),
    uniquePropertyIds: objectType.properties.filter((p) => p.unique).map((p) => p.id),
    links: Object.fromEntries(
      objectType.links.map((link) => [link.id, linkFingerprint(link, valueTypes)])
    ),
  }
}

/**
 * A branch's definitions, as data: what a snapshot is checked against and loaded by. The branch's
 * runtime computes it from its code; production copies into a branch from it alone, so production
 * never loads the branch's code. It is JSON.
 */
export interface BranchDefinitions {
  /** The revision of the branch's ontology, which its base commit records. */
  readonly ontologyRevision: string
  readonly types: Readonly<Record<string, BranchTypeDefinition>>
}

export interface BranchTypeDefinition extends TypeDefinitionManifest {
  readonly telemetryPropertyIds: readonly string[]
  /** The unique properties, with the kind their keys are written as. */
  readonly unique: readonly { readonly propertyId: string; readonly kind: UniqueValueKind }[]
  /** The properties that hold artifact references. */
  readonly artifactPropertyIds: readonly string[]
  /** Each link's cardinality, and every type it may point to, subtypes included. */
  readonly linkTargets: Readonly<
    Record<string, { readonly cardinality: "one" | "many"; readonly typeIds: readonly string[] }>
  >
  /** The configuration of each vector profile. */
  readonly vectors: Readonly<Record<string, string>>
}

export function branchDefinitions(ontology: OntologyRegistry): BranchDefinitions {
  const types = [...ontology.getObjectTypesById().values()]

  return {
    ontologyRevision: computeOntologyRevision(ontology),
    types: Object.fromEntries(
      types.map((objectType) => [
        objectType.id,
        {
          ...typeDefinitionManifest(objectType, ontology),
          telemetryPropertyIds: objectType.properties
            .filter((property) => property.mode === "telemetry")
            .map((property) => property.id),
          unique: ontology.listUniqueProperties(objectType.id).map(({ propertyId, kind }) => ({
            propertyId,
            kind,
          })),
          artifactPropertyIds: ontology
            .listArtifactRefProperties(objectType.id)
            .map((property) => property.id),
          linkTargets: Object.fromEntries(
            objectType.links.map((link) => [
              link.id,
              {
                cardinality: link.cardinality ?? "many",
                typeIds: types
                  .filter((target) =>
                    ontology.isValidLinkTarget(link.targetObjectTypeId, target.id)
                  )
                  .map((target) => target.id),
              },
            ])
          ),
          vectors: Object.fromEntries(
            Object.entries(objectType.search?.vectors ?? {}).map(([profile, definition]) => [
              profile,
              vectorConfiguration(definition),
            ])
          ),
        },
      ])
    ),
  }
}

/** How a type of the snapshot fits the importing runtime's definition of it. */
export type TypeFit =
  | {
      readonly fits: true
      /** Properties the branch no longer defines: their values are left out. */
      readonly droppedPropertyIds: readonly string[]
      /** Links the branch removed or redefined: their rows are left out. */
      readonly droppedLinkIds: readonly string[]
    }
  | { readonly fits: false; readonly reason: string }

/**
 * Whether objects stored under production's definition of a type are valid under the branch's.
 * A type fits unless the branch removed it, changed its primary property, changed a property both
 * define, or requires a property production does not.
 */
export function checkTypeFits(
  manifest: SnapshotTypeManifest,
  branch: TypeDefinitionManifest | undefined
): TypeFit {
  if (!branch) return { fits: false, reason: "the branch no longer defines this type" }

  if (branch.primaryPropertyId !== manifest.primaryPropertyId) {
    return {
      fits: false,
      reason: `its primary property changed from '${manifest.primaryPropertyId}' to '${branch.primaryPropertyId}'`,
    }
  }

  for (const [propertyId, fingerprint] of Object.entries(branch.properties)) {
    const production = manifest.properties[propertyId]
    if (production !== undefined && production !== fingerprint) {
      return { fits: false, reason: `property '${propertyId}' changed its type or mode` }
    }
  }

  for (const propertyId of branch.requiredPropertyIds) {
    if (!manifest.requiredPropertyIds.includes(propertyId)) {
      return {
        fits: false,
        reason: `property '${propertyId}' is required on the branch but not in production`,
      }
    }
  }

  return {
    fits: true,
    droppedPropertyIds: Object.keys(manifest.properties).filter(
      (propertyId) => branch.properties[propertyId] === undefined
    ),
    droppedLinkIds: Object.keys(manifest.links).filter(
      (linkId) => branch.links[linkId] !== manifest.links[linkId]
    ),
  }
}

function propertyFingerprint(property: Property, valueTypes: ReadonlyMap<string, ValueType>) {
  return sha256Canonical({
    schema: inlineSchema(property.schema, valueTypes, new Set()),
    mode: property.mode ?? "static",
    nullable: property.nullable ?? false,
  })
}

function linkFingerprint(link: ObjectLink, valueTypes: ReadonlyMap<string, ValueType>) {
  const targets = [link.targetObjectTypeId].flat().sort()

  return sha256Canonical({
    targets,
    cardinality: link.cardinality ?? "many",
    properties: (link.properties ?? []).map((property) => ({
      id: property.id,
      fingerprint: propertyFingerprint(property, valueTypes),
    })),
  })
}

/**
 * A schema with every value type it references written in place, without descriptions: renaming
 * or documenting a value type does not change what its values may be.
 */
function inlineSchema(
  schema: unknown,
  valueTypes: ReadonlyMap<string, ValueType>,
  seen: ReadonlySet<string>
): unknown {
  if (typeof schema !== "object" || schema === null) return schema
  if (Array.isArray(schema)) return schema.map((item) => inlineSchema(item, valueTypes, seen))

  const record = schema as Record<string, unknown>
  if (record.type === "valueTypeRef" && typeof record.valueTypeId === "string") {
    const valueType = valueTypes.get(record.valueTypeId)
    if (!valueType || seen.has(valueType.id)) return { valueType: record.valueTypeId }

    return inlineSchema(valueType.schema, valueTypes, new Set([...seen, valueType.id]))
  }

  const inlined: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === "description" || key === "_resolved") continue
    inlined[key] = inlineSchema(value, valueTypes, seen)
  }
  return inlined
}
