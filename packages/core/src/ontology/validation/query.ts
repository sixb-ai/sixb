import type { ObjectType, Property, Schema, ValueType } from ".."
import { OntologyValidationError } from "../errors"

type QueryFeature = "filterable" | "sortable" | "text" | "exact" | "facet" | "vector"

const queryFeatures: readonly QueryFeature[] = [
  "filterable",
  "sortable",
  "text",
  "exact",
  "facet",
  "vector",
]

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

  if (query.vector && !isVectorSchema(schema, valueTypesById)) {
    throw new OntologyValidationError(
      `[Sixb] Query metadata for property '${property.id}' on '${ownerPath}' enables vector search, but its schema is not a numeric array`
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

  if (search.vector) {
    const vectorProperty = requireObjectProperty(
      typeId,
      objectType,
      search.vector.property,
      "search.vector.property"
    )
    assertStaticSearchProfileProperty(typeId, vectorProperty, "search.vector.property")
    assertPropertyQueryFlag(typeId, vectorProperty, "vector", "search.vector.property")

    if (search.vector.source.length === 0) {
      throw new OntologyValidationError(
        `[Sixb] Object type '${typeId}' search.vector.source must include at least one source property`
      )
    }

    for (const sourceId of search.vector.source) {
      const sourceProperty = requireObjectProperty(
        typeId,
        objectType,
        sourceId,
        "search.vector.source"
      )
      assertStaticSearchProfileProperty(typeId, sourceProperty, "search.vector.source")
      assertPropertyQueryFlag(typeId, sourceProperty, "text", "search.vector.source")
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

function isVectorSchema(schema: Schema, valueTypesById: ReadonlyMap<string, ValueType>): boolean {
  if (typeof schema === "string") return false
  if (schema.type !== "array") return false

  const itemSchema = resolveSchema(schema.items, valueTypesById, "vector item")
  return itemSchema === "integer" || itemSchema === "double" || itemSchema === "decimal"
}
