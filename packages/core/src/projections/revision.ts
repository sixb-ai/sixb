import type { DatasetDefinition } from "../datasets"
import { compareStrings, type JsonValue } from "../json"
import { sha256Canonical } from "../materialization/identity"
import type { OntologyDefinitionCatalog } from "../ontology"
import type { ObjectFieldSchema, ObjectType, Property, Schema } from "../ontology/types"
import type { ProjectionDefinition, ProjectionOwnership } from "./types"

/** The whole ontology a project runs: every object type and the value types they reference. */
export function computeOntologyRevision(ontology: OntologyDefinitionCatalog): string {
  const objectTypes = [...ontology.getObjectTypesById().values()].sort((left, right) =>
    compareStrings(left.id, right.id)
  )
  return sha256Canonical({
    objectTypes: objectTypes.map(normalizeObjectType),
    valueTypes: normalizeReferencedValueTypes(ontology, objectTypes),
  })
}

/**
 * The part of the ontology one projection's output depends on, so that a deployment reruns only
 * the projections whose part changed.
 *
 * - The type the projection writes, which inheritance has already flattened. Committing validates
 *   the whole effective object or link scope against it, not only the mapped properties.
 * - The supertypes of each type it links to: a link accepts a target that is its declared target
 *   type or a subtype of it.
 * - The value types the written type references, transitively.
 *
 * Other types are not read. Links of other scopes that a commit re-resolves because it changed an
 * object's existence follow from that data change, under their own projections' revisions.
 */
export function computeProjectionOntologyRevision(
  projection: ProjectionDefinition,
  ontology: OntologyDefinitionCatalog
): string {
  const writtenType = ontology.resolveObjectType(writtenObjectTypeId(projection))
  return sha256Canonical({
    objectType: normalizeObjectType(writtenType),
    linkTargets: [...new Set(linkTargetObjectTypeIds(projection))]
      .sort(compareStrings)
      .map((objectTypeId) => ({
        id: objectTypeId,
        supertypes: listSupertypeIds(ontology, objectTypeId),
      })),
    valueTypes: normalizeReferencedValueTypes(ontology, [writtenType]),
  })
}

function writtenObjectTypeId(projection: ProjectionDefinition): string {
  return projection._tag === "LinkProjectionDefinition"
    ? projection.sourceObjectTypeId
    : projection.objectTypeId
}

function linkTargetObjectTypeIds(projection: ProjectionDefinition): readonly string[] {
  if (projection._tag === "ObjectProjectionDefinition") {
    return Object.values(projection.links).map((link) => link.targetObjectTypeId)
  }
  if (projection._tag === "LinkProjectionDefinition") return [projection.targetObjectTypeId]
  return []
}

/** Transitive `extends` and `parents`, sorted: what `isValidLinkTarget` matches a target against. */
function listSupertypeIds(ontology: OntologyDefinitionCatalog, objectTypeId: string): string[] {
  const supertypes = new Set<string>()
  const pending = [objectTypeId]
  for (let index = 0; index < pending.length; index += 1) {
    const objectType = ontology.resolveObjectType(pending[index])
    for (const supertypeId of [
      ...(objectType.extends ? [objectType.extends] : []),
      ...(objectType.parents ?? []),
    ]) {
      if (supertypes.has(supertypeId)) continue
      supertypes.add(supertypeId)
      pending.push(supertypeId)
    }
  }
  return [...supertypes].sort(compareStrings)
}

function normalizeReferencedValueTypes(
  ontology: OntologyDefinitionCatalog,
  objectTypes: readonly ObjectType[]
): JsonValue[] {
  return [...collectReferencedValueTypes(ontology, objectTypes)]
    .sort(compareStrings)
    .map((valueTypeId) => ontology.getValueTypesById().get(valueTypeId))
    .filter((valueType) => valueType !== undefined)
    .map((valueType) => ({
      id: valueType.id,
      schema: normalizeSchema(valueType.schema),
      semanticType: valueType.semanticType ?? null,
    }))
}

function collectReferencedValueTypes(
  ontology: OntologyDefinitionCatalog,
  objectTypes: readonly ObjectType[]
): ReadonlySet<string> {
  const referencedValueTypeIds = new Set<string>()
  for (const objectType of objectTypes) {
    for (const property of objectType.properties) {
      collectReferencedValueTypeIds(property.schema, referencedValueTypeIds)
    }
    for (const link of objectType.links) {
      for (const property of link.properties ?? []) {
        collectReferencedValueTypeIds(property.schema, referencedValueTypeIds)
      }
    }
  }
  const pending = [...referencedValueTypeIds]
  const queued = new Set(pending)
  for (let index = 0; index < pending.length; index += 1) {
    const valueType = ontology.getValueTypesById().get(pending[index])
    if (!valueType) continue
    collectReferencedValueTypeIds(valueType.schema, referencedValueTypeIds)
    for (const valueTypeId of referencedValueTypeIds) {
      if (queued.has(valueTypeId)) continue
      queued.add(valueTypeId)
      pending.push(valueTypeId)
    }
  }
  return referencedValueTypeIds
}

function normalizeObjectType(objectType: ObjectType): JsonValue {
  return {
    id: objectType.id,
    extends: objectType.extends ?? null,
    parents: [...(objectType.parents ?? [])].sort(),
    implements: [...(objectType.implements ?? [])].sort(),
    properties: [...objectType.properties]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map(normalizeProperty),
    links: [...objectType.links]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((link) => ({
        id: link.id,
        targetObjectTypeIds: Array.isArray(link.targetObjectTypeId)
          ? [...link.targetObjectTypeId].sort()
          : [link.targetObjectTypeId],
        cardinality: link.cardinality ?? "many",
        properties: [...(link.properties ?? [])]
          .sort((left, right) => compareStrings(left.id, right.id))
          .map(normalizeProperty),
      })),
  }
}

function collectReferencedValueTypeIds(schema: Schema, valueTypeIds: Set<string>): void {
  if (typeof schema === "string" || schema.type === "enum") return
  if (schema.type === "valueTypeRef") {
    valueTypeIds.add(schema.valueTypeId)
    return
  }
  if (schema.type === "array") {
    collectReferencedValueTypeIds(schema.items, valueTypeIds)
    return
  }
  if (schema.type === "map") {
    collectReferencedValueTypeIds(schema.valueSchema, valueTypeIds)
    return
  }
  for (const field of Object.values(schema.properties)) {
    collectReferencedValueTypeIds(field.schema, valueTypeIds)
  }
}

export function computeProjectionRevision(
  projection: ProjectionDefinition,
  dataset: DatasetDefinition
): string {
  const referencedColumns = projectionColumns(projection)
  const columns = dataset.schema.columns
    .filter((column) => referencedColumns.has(column.name))
    .map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable ?? false,
    }))
    .sort((left, right) => compareStrings(left.name, right.name))

  return sha256Canonical({
    mapping: normalizeProjectionDefinition(projection),
    columns,
  })
}

export function computeProjectionOwnershipHash(ownership: ProjectionOwnership): string {
  return sha256Canonical(ownership)
}

function normalizeProjectionDefinition(projection: ProjectionDefinition): JsonValue {
  if (projection._tag === "ObjectProjectionDefinition") {
    return {
      kind: "object",
      objectTypeId: projection.objectTypeId,
      properties: Object.fromEntries(
        Object.entries(projection.properties).sort(([left], [right]) => compareStrings(left, right))
      ),
      links: Object.fromEntries(
        Object.entries(projection.links)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([linkId, link]) => [
            linkId,
            {
              linkId: link.linkId,
              sourcePropertyId: link.sourcePropertyId ?? null,
              sourceField: link.sourceField ?? null,
              targetObjectTypeId: link.targetObjectTypeId,
            },
          ])
      ),
      conflictResolution: projection.conflictResolution ?? { strategy: "editsWin" },
    }
  }
  if (projection._tag === "LinkProjectionDefinition") {
    return {
      kind: "link",
      sourceObjectTypeId: projection.sourceObjectTypeId,
      linkId: projection.linkId,
      targetObjectTypeId: projection.targetObjectTypeId,
      sourceField: projection.sourceField,
      targetField: projection.targetField,
    }
  }
  const properties = Object.entries(projection.properties).sort(([left], [right]) =>
    compareStrings(left, right)
  )
  if (properties.length === 1) {
    const [propertyId, mapping] = properties[0]
    // Preserve the pre-grouping semantic hash for one-property projections. The authoring form and
    // lowered shape changed, but the source semantics did not; keeping the hash stable prevents a
    // deployment from invalidating queued jobs or replaying completed dataset versions.
    return {
      kind: "telemetry",
      objectTypeId: projection.objectTypeId,
      propertyId,
      objectIdField: projection.objectIdField,
      atField: projection.atField,
      valueField: mapping.valueField,
      unitField: mapping.unitField ?? null,
    }
  }
  return {
    kind: "telemetry",
    objectTypeId: projection.objectTypeId,
    objectIdField: projection.objectIdField,
    atField: projection.atField,
    properties: Object.fromEntries(
      properties.map(([propertyId, mapping]) => [
        propertyId,
        {
          valueField: mapping.valueField,
          unitField: mapping.unitField ?? null,
        },
      ])
    ),
  }
}

function projectionColumns(projection: ProjectionDefinition): Set<string> {
  if (projection._tag === "ObjectProjectionDefinition") {
    return new Set([
      ...Object.values(projection.properties),
      ...Object.values(projection.links).flatMap((link) =>
        link.sourceField === undefined ? [] : [link.sourceField]
      ),
      ...(projection.conflictResolution?.strategy === "mostRecent"
        ? [projection.conflictResolution.sourceTimestamp]
        : []),
    ])
  }
  if (projection._tag === "LinkProjectionDefinition") {
    return new Set([projection.sourceField, projection.targetField])
  }
  return new Set([
    projection.objectIdField,
    projection.atField,
    ...Object.values(projection.properties).flatMap((mapping) => [
      mapping.valueField,
      ...(mapping.unitField === undefined ? [] : [mapping.unitField]),
    ]),
  ])
}

function normalizeProperty(property: Property): JsonValue {
  return {
    id: property.id,
    schema: normalizeSchema(property.schema),
    required: property.required ?? false,
    nullable: property.nullable ?? false,
    primary: property.primary ?? false,
    // A projection planned before a property became unique carries no claims for its values, so
    // it must not commit after. Written only when set: other ontologies keep their revision.
    ...(property.unique ? { unique: true } : {}),
    mode: property.mode ?? "static",
    semanticType: property.semanticType ?? null,
  }
}

function normalizeSchema(schema: Schema): JsonValue {
  if (typeof schema === "string") return schema
  if (schema.type === "valueTypeRef") {
    return { type: "valueTypeRef", valueTypeId: schema.valueTypeId }
  }
  if (schema.type === "enum") {
    return {
      type: "enum",
      valueType: schema.valueType,
      values:
        schema.valueType === "string"
          ? [...schema.values].sort(compareStrings)
          : [...schema.values].sort((left, right) => left - right),
    }
  }
  if (schema.type === "array") {
    return { type: "array", items: normalizeSchema(schema.items) }
  }
  if (schema.type === "map") {
    return {
      type: "map",
      keySchema: schema.keySchema,
      valueSchema: normalizeSchema(schema.valueSchema),
    }
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(schema.properties)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([fieldId, field]) => [fieldId, normalizeField(field)])
    ),
  }
}

function normalizeField(field: ObjectFieldSchema): JsonValue {
  return {
    schema: normalizeSchema(field.schema),
    required: field.required ?? false,
    nullable: field.nullable ?? false,
    semanticType: field.semanticType ?? null,
  }
}
