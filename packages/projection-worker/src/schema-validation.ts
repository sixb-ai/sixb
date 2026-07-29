import type {
  DatasetColumnDefinition,
  DatasetDefinition,
  ObjectLink,
  ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  ProjectionDefinition,
  Property,
  Schema,
  ValueType,
} from "@sixb/core"
import { validateTelemetryProjectionFieldMapping } from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { ProjectionWorkerPermanentError } from "./errors"
import { isIntegerEnumSchema, resolveProjectionSchema } from "./projection-schema"

type DatasetColumnsByName = Map<string, DatasetColumnDefinition>

function columnsByName(columns: readonly DatasetColumnDefinition[]): DatasetColumnsByName {
  return new Map(columns.map((column) => [column.name, column]))
}

function projectionDatasetColumns(projection: ProjectionDefinition): ReadonlySet<string> {
  if (projection._tag === "ObjectProjectionDefinition") {
    return new Set([
      ...Object.values(projection.properties),
      ...Object.values(projection.links).flatMap((link) =>
        link.sourceField === undefined ? [] : [link.sourceField]
      ),
    ])
  }
  if (projection._tag === "LinkProjectionDefinition") {
    return new Set([projection.sourceField, projection.targetField])
  }
  return new Set([
    projection.objectIdField,
    projection.atField,
    projection.valueField,
    ...(projection.unitField === undefined ? [] : [projection.unitField]),
  ])
}

function columnsEqual(expected: DatasetColumnDefinition, actual: DatasetColumnDefinition): boolean {
  return expected.type === actual.type && Boolean(expected.nullable) === Boolean(actual.nullable)
}

function formatColumn(column: DatasetColumnDefinition | undefined): string {
  if (!column) return "a missing column"
  return `'${column.name}:${column.type}${column.nullable ? " nullable" : ""}'`
}

export function assertDatasetVersionMatchesDefinition(input: {
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readonly projection: ProjectionDefinition
}): void {
  const { dataset, version, projection } = input

  if (version.datasetId !== dataset.id) {
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Dataset version '${version.versionId}' belongs to dataset '${version.datasetId}', expected '${dataset.id}'.`
    )
  }

  const expectedColumns = columnsByName(dataset.schema.columns)
  const actualColumns = columnsByName(version.schema.columns)
  for (const columnName of projectionDatasetColumns(projection)) {
    const expected = expectedColumns.get(columnName)
    const actual = actualColumns.get(columnName)
    if (expected && actual && columnsEqual(expected, actual)) continue
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Dataset '${dataset.id}' version '${version.versionId}' schema mismatch for referenced column '${columnName}'. Expected ${formatColumn(expected)}, got ${formatColumn(actual)}.`
    )
  }
}

export function assertProjectionCompatibleWithDataset(input: {
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readonly ontology: OntologyRegistry
}): void {
  const { projection, dataset, version, ontology } = input
  const columnsByName = new Map(version.schema.columns.map((column) => [column.name, column]))

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
        throw new ProjectionWorkerPermanentError(
          `[SixbProjectionWorker] Projection '${projection.id}' references unknown property '${propertyId}' on object type '${objectType.id}'.`
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
        throw new ProjectionWorkerPermanentError(
          `[SixbProjectionWorker] Projection '${projection.id}' maps dataset column '${column.name}' (${column.type}) to incompatible property '${propertyId}'.`
        )
      }
    }

    for (const [linkKey, descriptor] of Object.entries(projection.links)) {
      if (linkKey !== descriptor.linkId) {
        throw new ProjectionWorkerPermanentError(
          `[SixbProjectionWorker] Projection '${projection.id}' FK link key '${linkKey}' does not match descriptor link '${descriptor.linkId}'.`
        )
      }

      const linkDefinition = requireLink(objectType, descriptor.linkId, projection.id)
      const sourcePropertyId = descriptor.sourcePropertyId
      const sourceField = descriptor.sourceField
      if (sourcePropertyId && sourceField) {
        throw new ProjectionWorkerPermanentError(
          `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' must use either sourcePropertyId or sourceField, not both.`
        )
      }
      if (!sourcePropertyId && !sourceField) {
        throw new ProjectionWorkerPermanentError(
          `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' must declare sourcePropertyId or sourceField.`
        )
      }

      if (sourcePropertyId) {
        requireProperty(
          objectType,
          sourcePropertyId,
          projection.id,
          `FK link '${descriptor.linkId}' source property`
        )

        if (!(sourcePropertyId in projection.properties)) {
          throw new ProjectionWorkerPermanentError(
            `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' source property '${sourcePropertyId}' must be mapped as an object property.`
          )
        }
      }

      if (sourceField) {
        const sourceColumn = requireColumn(columnsByName, dataset.id, sourceField, projection.id)
        if (sourceColumn.type !== "string") {
          throw new ProjectionWorkerPermanentError(
            `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' source field '${sourceField}' must be a string dataset column.`
          )
        }
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

  if (projection._tag === "TelemetryProjectionDefinition") {
    const objectType = requireObjectType(
      ontology,
      projection.objectTypeId,
      projection.id,
      "object type"
    )
    // Existence + telemetry-mode + field-mapping rules are owned by core so the
    // startup and worker checks share one implementation and cannot drift. The
    // worker then layers dataset-version column type compatibility on top.
    const datasetColumnNames = new Set(dataset.schema.columns.map((column) => column.name))
    const property = validateTelemetryProjectionFieldMapping(
      projection,
      objectType,
      datasetColumnNames,
      `[SixbProjectionWorker] Projection "${projection.id}"`
    )

    const objectIdColumn = requireColumn(
      columnsByName,
      dataset.id,
      projection.objectIdField,
      projection.id
    )
    if (objectIdColumn.type !== "string") {
      throw new ProjectionWorkerPermanentError(
        `[SixbProjectionWorker] Telemetry projection '${projection.id}' objectId field '${projection.objectIdField}' must be a string dataset column.`
      )
    }

    const atColumn = requireColumn(columnsByName, dataset.id, projection.atField, projection.id)
    if (!isDateLikeColumnType(atColumn.type)) {
      throw new ProjectionWorkerPermanentError(
        `[SixbProjectionWorker] Telemetry projection '${projection.id}' at field '${projection.atField}' must be a string, date, or timestamp dataset column.`
      )
    }

    const valueColumn = requireColumn(
      columnsByName,
      dataset.id,
      projection.valueField,
      projection.id
    )
    if (
      !isDatasetColumnCompatibleWithSchema(
        valueColumn.type,
        property.schema,
        ontology.getValueTypesById()
      )
    ) {
      throw new ProjectionWorkerPermanentError(
        `[SixbProjectionWorker] Telemetry projection '${projection.id}' maps dataset column '${valueColumn.name}' (${valueColumn.type}) to incompatible property '${projection.propertyId}'.`
      )
    }

    if (projection.unitField !== undefined) {
      const unitColumn = requireColumn(
        columnsByName,
        dataset.id,
        projection.unitField,
        projection.id
      )
      if (unitColumn.type !== "string") {
        throw new ProjectionWorkerPermanentError(
          `[SixbProjectionWorker] Telemetry projection '${projection.id}' unit field '${projection.unitField}' must be a string dataset column.`
        )
      }
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
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Link projection '${projection.id}' source and target fields must be string dataset columns.`
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
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Projection '${projectionId}' references unknown ${role} '${objectTypeId}'.`
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
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Projection '${projectionId}' references unknown ${role} '${propertyId}' on object type '${objectType.id}'.`
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
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Projection '${projectionId}' references unknown link '${linkId}' on object type '${objectType.id}'.`
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

  throw new ProjectionWorkerPermanentError(
    `[SixbProjectionWorker] Projection '${projectionId}' link '${link.id}' target type '${actualTargetObjectTypeId}' is not compatible with declared target '${formatTarget(link.targetObjectTypeId)}'.`
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
    throw new ProjectionWorkerPermanentError(
      `[SixbProjectionWorker] Projection '${projectionId}' references unknown dataset column '${columnName}' on dataset '${datasetId}'.`
    )
  }
  return column
}

function isDateLikeColumnType(type: DatasetColumnDefinition["type"]): boolean {
  return type === "string" || type === "date" || type === "timestamp"
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
      return resolved === "double"
    case "decimal":
      return resolved === "decimal" || resolved === "double"
    case "date":
      return resolved === "date"
    case "timestamp":
      return resolved === "timestamp"
    case "json":
      return isJsonCompatibleSchema(resolved)
    case "fileRef":
      return resolved === "fileRef"
  }
}

function isStringEnumSchema(schema: Schema): boolean {
  return typeof schema !== "string" && schema.type === "enum" && schema.valueType === "string"
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
