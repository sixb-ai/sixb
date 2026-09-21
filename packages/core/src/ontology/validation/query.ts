import { assertEmbeddingModelRef } from "../../models/embedding-model"
import type { ObjectType, Property, Schema, ValueType } from ".."
import { OntologyValidationError } from "../errors"

type QueryFeature = "filterable" | "sortable" | "text" | "exact" | "facet"

const queryFeatures: readonly QueryFeature[] = ["filterable", "sortable", "text", "exact", "facet"]

export function validateQueryMetadata(
  objectTypesById: ReadonlyMap<string, ObjectType>,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  for (const [typeId, objectType] of objectTypesById) {
    validatePropertiesQueryMetadata(typeId, objectType.properties, valueTypesById)

    for (const link of objectType.links) {
      if (link.properties) {
        validatePropertiesQueryMetadata(`${typeId}.${link.id}`, link.properties, valueTypesById)
      }
    }

    validateObjectSearchMetadata(typeId, objectType, valueTypesById)
  }
}

function validatePropertiesQueryMetadata(
  ownerPath: string,
  properties: readonly Property[],
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  for (const property of properties) {
    validatePropertyQueryMetadata(ownerPath, property, valueTypesById)
  }
}

function validatePropertyQueryMetadata(
  ownerPath: string,
  property: Property,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  const query = property.query
  if (!query) return
  if ("vector" in query) {
    throw new OntologyValidationError(
      `[Sixb] Property '${property.id}' on '${ownerPath}' uses removed query.vector metadata. Declare search.vectors on the object type instead.`
    )
  }

  const enabledFeatures = queryFeatures.filter((feature) => query[feature] === true)
  if ((enabledFeatures.length > 0 || query.weight !== undefined) && query.searchable !== true) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' must set query.searchable: true before enabling query features`
    )
  }

  if (query.weight !== undefined) {
    if (!Number.isFinite(query.weight) || query.weight <= 0) {
      throw new OntologyValidationError(
        `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' has invalid text weight. Expected a positive finite number.`
      )
    }
    if (query.text !== true) {
      throw new OntologyValidationError(
        `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' can only set weight when query.text is true`
      )
    }
  }

  if (enabledFeatures.length === 0) return

  const schema = resolveQueryableSchema(property, ownerPath, valueTypesById)

  if (query.text && !isTextSearchableSchema(schema)) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' enables text search, but its schema is not string-like`
    )
  }

  if (query.exact && !isExactSearchableSchema(schema)) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' enables exact search, but its schema cannot be exact-matched`
    )
  }

  if (query.filterable && !isFilterableSchema(schema)) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' enables filtering, but its schema cannot be filtered`
    )
  }

  if (query.sortable && !isSortableSchema(schema)) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' enables sorting, but its schema is not orderable`
    )
  }

  if (query.facet && !isFacetSchema(schema)) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' enables faceting, but its schema cannot be faceted`
    )
  }
}

function validateObjectSearchMetadata(
  typeId: string,
  objectType: ObjectType,
  valueTypesById: ReadonlyMap<string, ValueType>
): void {
  const search = objectType.search
  if (!search) return
  if ("vector" in search) {
    throw new OntologyValidationError(
      `[Sixb] Object type '${typeId}' uses removed search.vector metadata. Declare named profiles in search.vectors instead.`
    )
  }

  for (const [name, profile] of Object.entries(search.vectors ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
      throw new OntologyValidationError(`[Sixb] Invalid vector profile name ${name}`)
    assertEmbeddingModelRef(profile.model)
    if (
      !Array.isArray(profile.source) ||
      profile.source.length === 0 ||
      new Set(profile.source).size !== profile.source.length
    ) {
      throw new OntologyValidationError(
        `[Sixb] Vector profile ${name} requires unique, nonempty source fields.`
      )
    }
    for (const id of profile.source) {
      const property = requireObjectProperty(typeId, objectType, id, `search.vectors.${name}`)
      assertStaticSearchProfileProperty(typeId, property, `search.vectors.${name}`)
      if (!isTextSearchableSchema(resolveQueryableSchema(property, typeId, valueTypesById))) {
        throw new OntologyValidationError(`[Sixb] Vector source must be text: ${typeId}.${id}`)
      }
    }
  }
  const primaryPropertyId = objectType.properties.find((property) => property.primary)?.id

  if (search.title) {
    const title = requireObjectProperty(typeId, objectType, search.title, "search.title")
    assertStaticSearchProfileProperty(typeId, title, "search.title")
    const schema = resolveQueryableSchema(title, typeId, valueTypesById)
    if (!isTextSearchableSchema(schema)) {
      throw new OntologyValidationError(
        `[Sixb] Object type '${typeId}' search.title references '${title.id}', but title fields must be string-like`
      )
    }
  }

  for (const propertyId of search.defaultText ?? []) {
    const property = requireObjectProperty(typeId, objectType, propertyId, "search.defaultText")
    assertStaticSearchProfileProperty(typeId, property, "search.defaultText")
    assertPropertyQueryFlag(typeId, property, "text", "search.defaultText")
  }

  for (const propertyId of search.exact ?? []) {
    const property = requireObjectProperty(typeId, objectType, propertyId, "search.exact")
    assertStaticSearchProfileProperty(typeId, property, "search.exact")
    if (property.id !== primaryPropertyId) {
      assertPropertyQueryFlag(typeId, property, "exact", "search.exact")
    }
  }
}

function requireObjectProperty(
  typeId: string,
  objectType: ObjectType,
  propertyId: string,
  metadataPath: string
): Property {
  const property = objectType.properties.find((candidate) => candidate.id === propertyId)
  if (!property) {
    throw new OntologyValidationError(
      `[Sixb] Object type '${typeId}' ${metadataPath} references unknown property '${propertyId}'`
    )
  }
  return property
}

function assertStaticSearchProfileProperty(
  typeId: string,
  property: Property,
  metadataPath: string
): void {
  if (property.mode === "telemetry") {
    throw new OntologyValidationError(
      `[Sixb] Object type '${typeId}' ${metadataPath} references telemetry property '${property.id}'. Search profiles can only reference static properties because telemetry latest values are not object-query indexed.`
    )
  }
}

function assertPropertyQueryFlag(
  typeId: string,
  property: Property,
  flag: QueryFeature,
  metadataPath: string
): void {
  if (property.query?.searchable === true && property.query[flag] === true) {
    return
  }

  throw new OntologyValidationError(
    `[Sixb] Object type '${typeId}' ${metadataPath} references property '${property.id}', but that property must set query.searchable: true and query.${flag}: true`
  )
}

function resolveQueryableSchema(
  property: Property,
  ownerPath: string,
  valueTypesById: ReadonlyMap<string, ValueType>
): Schema {
  return resolveSchema(property.schema, valueTypesById, `${ownerPath}.${property.id}`)
}

function resolveSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  path: string,
  seenValueTypeIds = new Set<string>()
): Schema {
  if (typeof schema === "string") {
    return schema
  }

  if (schema.type !== "valueTypeRef") {
    return schema
  }

  if (seenValueTypeIds.has(schema.valueTypeId)) {
    throw new OntologyValidationError(
      `[Sixb] Circular valueTypeRef '${schema.valueTypeId}' in query metadata at ${path}`
    )
  }

  const resolved = schema._resolved ?? valueTypesById.get(schema.valueTypeId)?.schema
  if (!resolved) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for ${path} references unknown valueTypeRef '${schema.valueTypeId}'`
    )
  }

  seenValueTypeIds.add(schema.valueTypeId)
  return resolveSchema(resolved, valueTypesById, path, seenValueTypeIds)
}

function isTextSearchableSchema(schema: Schema): boolean {
  if (schema === "string") return true
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "string"
}

function isExactSearchableSchema(schema: Schema): boolean {
  if (typeof schema === "string") {
    return schema !== "fileRef"
  }
  return schema.type === "enum"
}

function isFilterableSchema(schema: Schema): boolean {
  return (
    isExactSearchableSchema(schema) ||
    (typeof schema !== "string" && (schema.type === "array" || schema.type === "map"))
  )
}

function isSortableSchema(schema: Schema): boolean {
  if (typeof schema === "string") {
    return (
      schema === "string" ||
      schema === "uuid" ||
      schema === "integer" ||
      schema === "double" ||
      schema === "decimal" ||
      schema === "date" ||
      schema === "timestamp"
    )
  }
  return schema.type === "enum"
}

function isFacetSchema(schema: Schema): boolean {
  return isExactSearchableSchema(schema)
}
