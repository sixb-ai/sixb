import { sha256Canonical } from "../materialization/identity"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectLink, ObjectType, Property, ValueType } from "../ontology/types"
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
 * define, or requires a property production does not. A required property hidden from the person
 * does not skip the type: it is read and linked, and a write that leaves it unset fails.
 */
export function checkTypeFits(
  manifest: SnapshotTypeManifest,
  ontology: OntologyDefinitionCatalog
): TypeFit {
  const objectType = ontology.getObjectTypeById(manifest.objectTypeId)
  if (!objectType) return { fits: false, reason: "the branch no longer defines this type" }

  const branch = typeDefinitionManifest(objectType, ontology)
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
