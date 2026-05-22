import type {
  DatasetColumnDefinition,
  DatasetDefinition,
  DatasetVersion,
  ObjectLink,
  ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  ProjectionDefinition,
  Property,
  Schema,
  ValueType,
} from "@pario/core"
import { ProjectionWorkerError } from "./errors"

type DatasetColumnsByName = Map<string, DatasetColumnDefinition>

export function projectionKindOf(projection: ProjectionDefinition): "object" | "link" {
  return projection._tag === "ObjectProjectionDefinition" ? "object" : "link"
}

export function assertDatasetVersionMatchesDefinition(input: {
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
}): void {
  const { dataset, version } = input

  if (version.datasetId !== dataset.id) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Dataset version '${version.versionId}' belongs to dataset '${version.datasetId}', expected '${dataset.id}'.`
    )
  }

  const expectedColumns = dataset.schema.columns
  const actualColumns = version.schema.columns
  if (expectedColumns.length !== actualColumns.length) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Dataset '${dataset.id}' version '${version.versionId}' schema has ${actualColumns.length} column(s), expected ${expectedColumns.length}.`
    )
  }

  for (let index = 0; index < expectedColumns.length; index += 1) {
    const expected = expectedColumns[index]!
    const actual = actualColumns[index]!
    if (
      expected.name !== actual.name ||
      expected.type !== actual.type ||
      Boolean(expected.nullable) !== Boolean(actual.nullable)
    ) {
      throw new ProjectionWorkerError(
        `[ParioProjectionWorker] Dataset '${dataset.id}' version '${version.versionId}' schema mismatch at column ${index}. Expected '${expected.name}:${expected.type}', got '${actual.name}:${actual.type}'.`
      )
    }
  }
}

export function assertProjectionCompatibleWithDataset(input: {
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly ontology: OntologyRegistry
}): void {
  const { projection, dataset, ontology } = input
  const columnsByName = new Map(dataset.schema.columns.map((column) => [column.name, column]))

  if (projection._tag === "ObjectProjectionDefinition") {
    const objectType = requireObjectType(
      ontology,
      projection.objectTypeId,
      projection.id,
      "object type"
    )

    const propertiesById = new Map(
      objectType.properties.map((property) => [property.id, property] as const)
    )
    for (const [propertyId, columnName] of Object.entries(projection.properties)) {
      const property = propertiesById.get(propertyId)
      if (!property) {
        throw new ProjectionWorkerError(
          `[ParioProjectionWorker] Projection '${projection.id}' references unknown property '${propertyId}' on object type '${objectType.id}'.`
        )
      }

      const column = requireColumn(columnsByName, dataset.id, columnName, projection.id)
      if (
        !isDatasetColumnCompatibleWithSchema(
          column.type,
          property.schema,
          ontology.getValueTypesById()
        )
      ) {
        throw new ProjectionWorkerError(
          `[ParioProjectionWorker] Projection '${projection.id}' maps dataset column '${column.name}' (${column.type}) to incompatible property '${propertyId}'.`
        )
      }
    }

    for (const [linkKey, descriptor] of Object.entries(projection.links)) {
      if (linkKey !== descriptor.linkId) {
        throw new ProjectionWorkerError(
          `[ParioProjectionWorker] Projection '${projection.id}' FK link key '${linkKey}' does not match descriptor link '${descriptor.linkId}'.`
        )
      }

      const linkDefinition = requireLink(objectType, descriptor.linkId, projection.id)
      requireProperty(
        objectType,
        descriptor.sourcePropertyId,
        projection.id,
        `FK link '${descriptor.linkId}' source property`
      )

      if (!(descriptor.sourcePropertyId in projection.properties)) {
        throw new ProjectionWorkerError(
          `[ParioProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' source property '${descriptor.sourcePropertyId}' must be mapped as an object property.`
        )
      }

      requireObjectType(
        ontology,
        descriptor.targetObjectTypeId,
        projection.id,
        `FK link '${descriptor.linkId}' target type`
      )
      assertLinkTargetCompatible({
        ontology,
        projectionId: projection.id,
        link: linkDefinition,
        actualTargetObjectTypeId: descriptor.targetObjectTypeId,
      })
    }
    return
  }

  const sourceObjectType = requireObjectType(
    ontology,
    projection.sourceObjectTypeId,
    projection.id,
    "source object type"
  )
  requireObjectType(ontology, projection.targetObjectTypeId, projection.id, "target object type")
  const linkDefinition = requireLink(sourceObjectType, projection.linkId, projection.id)
  assertLinkTargetCompatible({
    ontology,
    projectionId: projection.id,
    link: linkDefinition,
    actualTargetObjectTypeId: projection.targetObjectTypeId,
  })

  const sourceColumn = requireColumn(
    columnsByName,
    dataset.id,
    projection.sourceField,
    projection.id
  )
  const targetColumn = requireColumn(
    columnsByName,
    dataset.id,
    projection.targetField,
    projection.id
  )

  if (sourceColumn.type !== "string" || targetColumn.type !== "string") {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Link projection '${projection.id}' source and target fields must be string dataset columns.`
    )
  }
}

function requireObjectType(
  ontology: OntologyRegistry,
  objectTypeId: string,
  projectionId: string,
  role: string
): ObjectTypeWithPropertyTokens {
  const objectType = ontology.getObjectTypeById(objectTypeId)
  if (!objectType) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Projection '${projectionId}' references unknown ${role} '${objectTypeId}'.`
    )
  }
  return objectType
}

function requireProperty(
  objectType: ObjectTypeWithPropertyTokens,
  propertyId: string,
  projectionId: string,
  role: string
): Property {
  const property = objectType.properties.find((candidate) => candidate.id === propertyId)
  if (!property) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Projection '${projectionId}' references unknown ${role} '${propertyId}' on object type '${objectType.id}'.`
    )
  }
  return property
}

function requireLink(
  objectType: ObjectTypeWithPropertyTokens,
  linkId: string,
  projectionId: string
): ObjectLink {
  const link = objectType.links.find((candidate) => candidate.id === linkId)
  if (!link) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Projection '${projectionId}' references unknown link '${linkId}' on object type '${objectType.id}'.`
    )
  }
  return link
}

function assertLinkTargetCompatible(input: {
  readonly ontology: OntologyRegistry
  readonly projectionId: string
  readonly link: ObjectLink
  readonly actualTargetObjectTypeId: string
}): void {
  const { ontology, projectionId, link, actualTargetObjectTypeId } = input
  if (ontology.isValidLinkTarget(link.targetObjectTypeId, actualTargetObjectTypeId)) {
    return
  }

  throw new ProjectionWorkerError(
    `[ParioProjectionWorker] Projection '${projectionId}' link '${link.id}' target type '${actualTargetObjectTypeId}' is not compatible with declared target '${formatTarget(link.targetObjectTypeId)}'.`
  )
}

function formatTarget(target: string | readonly string[]): string {
  return typeof target === "string" ? target : target.join(" | ")
}

function requireColumn(
  columnsByName: DatasetColumnsByName,
  datasetId: string,
  columnName: string,
  projectionId: string
): DatasetColumnDefinition {
  const column = columnsByName.get(columnName)
  if (!column) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Projection '${projectionId}' references unknown dataset column '${columnName}' on dataset '${datasetId}'.`
    )
  }
  return column
}

function isDatasetColumnCompatibleWithSchema(
  columnType: DatasetColumnDefinition["type"],
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>
): boolean {
  const resolved = resolveProjectionSchema(schema, valueTypesById)

  switch (columnType) {
    case "string":
      return resolved === "string" || resolved === "uuid" || isStringEnumSchema(resolved)
    case "boolean":
      return resolved === "boolean"
    case "int64":
      return (
        resolved === "integer" ||
        resolved === "double" ||
        resolved === "decimal" ||
        isIntegerEnumSchema(resolved)
      )
    case "float64":
      return resolved === "double" || resolved === "decimal"
    case "decimal":
      return resolved === "decimal" || resolved === "double"
    case "date":
      return resolved === "date"
    case "timestamp":
      return resolved === "timestamp"
    case "json":
      return isJsonCompatibleSchema(resolved)
    case "fileRef":
      return false
  }
}

function resolveProjectionSchema(
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seen = new Set<string>()
): Schema {
  if (typeof schema === "string") {
    return schema
  }

  if (schema.type !== "valueTypeRef") {
    return schema
  }

  if (seen.has(schema.valueTypeId)) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Circular valueTypeRef '${schema.valueTypeId}' in projection schema.`
    )
  }

  const nextSeen = new Set(seen)
  nextSeen.add(schema.valueTypeId)

  if (schema._resolved) {
    return resolveProjectionSchema(schema._resolved, valueTypesById, nextSeen)
  }

  const valueType = valueTypesById.get(schema.valueTypeId)
  if (!valueType) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Unknown valueTypeRef '${schema.valueTypeId}' in projection schema.`
    )
  }

  return resolveProjectionSchema(valueType.schema, valueTypesById, nextSeen)
}

function isStringEnumSchema(schema: Schema): boolean {
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "string"
}

function isIntegerEnumSchema(schema: Schema): boolean {
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "integer"
}

function isJsonCompatibleSchema(schema: Schema): boolean {
  return (
    typeof schema !== "string" &&
    (schema.type === "object" ||
      schema.type === "array" ||
      schema.type === "map" ||
      schema.type === "enum")
  )
}
