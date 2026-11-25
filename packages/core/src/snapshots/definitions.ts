import { sha256Canonical } from "../materialization/identity"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectLink, ObjectType, Property, ValueType } from "../ontology/types"
import type { SnapshotTypeManifest } from "./format"

/** What the manifest records of a type's definition, for an importer to compare with its own. */
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
