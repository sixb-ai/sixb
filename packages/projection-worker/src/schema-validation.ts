import type {
  DatasetColumnDefinition,
  DatasetDefinition,
  ObjectLink,
  ObjectTypeWithPropertyTokens,
  OntologyDefinitionCatalog,
  ProjectionDefinition,
  Property,
  ReadonlyJsonValue,
  Schema,
  ValueType,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { validateTelemetryProjectionFieldMapping } from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { isIntegerEnumSchema, resolveProjectionSchema } from "./projection-schema"

type DatasetColumnsByName = Map<string, DatasetColumnDefinition>
type ProjectionErrorDetails = Readonly<Record<string, ReadonlyJsonValue>>

interface ProjectionValidationContext {
  readonly projectionId: string
  readonly datasetId: string
  readonly versionId: string
  readonly runId?: string
}

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
  readonly runId?: string
}): void {
  const { dataset, version, projection, runId } = input
  const context = projectionValidationContext({ projection, dataset, version, runId })

  if (version.datasetId !== dataset.id) {
    throw incompatibleDatasetVersion(
      `[SixbProjectionWorker] Dataset version '${version.versionId}' belongs to dataset '${version.datasetId}', expected '${dataset.id}'.`,
      { ...context, actualDatasetId: version.datasetId }
    )
  }

  const expectedColumns = columnsByName(dataset.schema.columns)
  const actualColumns = columnsByName(version.schema.columns)
  for (const columnName of projectionDatasetColumns(projection)) {
    const expected = expectedColumns.get(columnName)
    const actual = actualColumns.get(columnName)
    if (expected && actual && columnsEqual(expected, actual)) continue
    throw incompatibleDatasetVersion(
      `[SixbProjectionWorker] Dataset '${dataset.id}' version '${version.versionId}' schema mismatch for referenced column '${columnName}'. Expected ${formatColumn(expected)}, got ${formatColumn(actual)}.`,
      {
        ...context,
        columnName,
        expectedColumn: formatColumn(expected),
        actualColumn: formatColumn(actual),
      }
    )
  }
}

export function assertProjectionCompatibleWithDataset(input: {
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readonly ontology: OntologyDefinitionCatalog
  readonly runId?: string
}): void {
  const { projection, dataset, version, ontology, runId } = input
  const context = projectionValidationContext({ projection, dataset, version, runId })
  const columnsByName = new Map(version.schema.columns.map((column) => [column.name, column]))

  if (projection._tag === "ObjectProjectionDefinition") {
    const objectType = requireObjectType(ontology, projection.objectTypeId, "object type", context)

    const propertiesById = new Map(
      objectType.properties.map((property) => [property.id, property] as const)
    )
    for (const [propertyId, columnName] of Object.entries(projection.properties)) {
      const property = propertiesById.get(propertyId)
      if (!property) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' references unknown property '${propertyId}' on object type '${objectType.id}'.`,
          { ...context, objectTypeId: objectType.id, propertyId, columnName }
        )
      }

      const column = requireColumn(columnsByName, columnName, context)
      if (
        !isDatasetColumnCompatibleWithSchema(
          column.type,
          property.schema,
          ontology.getValueTypesById(),
          {
            ...context,
            objectTypeId: objectType.id,
            propertyId,
            columnName,
          }
        )
      ) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' maps dataset column '${column.name}' (${column.type}) to incompatible property '${propertyId}'.`,
          {
            ...context,
            objectTypeId: objectType.id,
            propertyId,
            columnName: column.name,
            columnType: column.type,
          }
        )
      }
    }

    if (projection.conflictResolution?.strategy === "mostRecent") {
      const column = requireColumn(
        columnsByName,
        projection.conflictResolution.sourceTimestamp,
        context
      )
      if (column.type !== "timestamp") {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' source timestamp '${column.name}' must be a timestamp dataset column.`,
          { ...context, columnName: column.name, columnType: column.type }
        )
      }
      if (column.nullable === true) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' source timestamp '${column.name}' must be a non-null timestamp dataset column.`,
          { ...context, columnName: column.name, columnType: column.type, nullable: true }
        )
      }
    }

    for (const [linkKey, descriptor] of Object.entries(projection.links)) {
      if (linkKey !== descriptor.linkId) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' FK link key '${linkKey}' does not match descriptor link '${descriptor.linkId}'.`,
          { ...context, linkKey, linkId: descriptor.linkId }
        )
      }

      const linkDefinition = requireLink(objectType, descriptor.linkId, context)
      const sourcePropertyId = descriptor.sourcePropertyId
      const sourceField = descriptor.sourceField
      if (sourcePropertyId && sourceField) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' must use either sourcePropertyId or sourceField, not both.`,
          {
            ...context,
            linkId: descriptor.linkId,
            propertyId: sourcePropertyId,
            columnName: sourceField,
          }
        )
      }
      if (!sourcePropertyId && !sourceField) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' must declare sourcePropertyId or sourceField.`,
          { ...context, linkId: descriptor.linkId }
        )
      }

      if (sourcePropertyId) {
        requireProperty(
          objectType,
          sourcePropertyId,
          `FK link '${descriptor.linkId}' source property`,
          context
        )

        if (!(sourcePropertyId in projection.properties)) {
          throw invalidProjectionDefinition(
            `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' source property '${sourcePropertyId}' must be mapped as an object property.`,
            { ...context, linkId: descriptor.linkId, propertyId: sourcePropertyId }
          )
        }
      }

      if (sourceField) {
        const sourceColumn = requireColumn(columnsByName, sourceField, context)
        if (sourceColumn.type !== "string") {
          throw invalidProjectionDefinition(
            `[SixbProjectionWorker] Projection '${projection.id}' FK link '${descriptor.linkId}' source field '${sourceField}' must be a string dataset column.`,
            {
              ...context,
              linkId: descriptor.linkId,
              columnName: sourceField,
              columnType: sourceColumn.type,
            }
          )
        }
      }

      requireObjectType(
        ontology,
        descriptor.targetObjectTypeId,
        `FK link '${descriptor.linkId}' target type`,
        context
      )
      assertLinkTargetCompatible({
        ontology,
        context,
        link: linkDefinition,
        actualTargetObjectTypeId: descriptor.targetObjectTypeId,
      })
    }
    return
  }

  if (projection._tag === "TelemetryProjectionDefinition") {
    const objectType = requireObjectType(ontology, projection.objectTypeId, "object type", context)
    // Existence + telemetry-mode + field-mapping rules are owned by core so the
    // startup and worker checks share one implementation and cannot drift. The
    // worker then layers dataset-version column type compatibility on top.
    const datasetColumnNames = new Set(dataset.schema.columns.map((column) => column.name))
    const properties = validateTelemetryProjectionFieldMapping(
      projection,
      objectType,
      datasetColumnNames,
      ontology.getValueTypesById(),
      `[SixbProjectionWorker] Projection "${projection.id}"`
    )

    const objectIdColumn = requireColumn(columnsByName, projection.objectIdField, context)
    if (objectIdColumn.type !== "string") {
      throw invalidProjectionDefinition(
        `[SixbProjectionWorker] Telemetry projection '${projection.id}' objectId field '${projection.objectIdField}' must be a string dataset column.`,
        {
          ...context,
          objectTypeId: objectType.id,
          columnName: projection.objectIdField,
          columnType: objectIdColumn.type,
        }
      )
    }

    const atColumn = requireColumn(columnsByName, projection.atField, context)
    if (!isDateLikeColumnType(atColumn.type)) {
      throw invalidProjectionDefinition(
        `[SixbProjectionWorker] Telemetry projection '${projection.id}' at field '${projection.atField}' must be a string, date, or timestamp dataset column.`,
        {
          ...context,
          objectTypeId: objectType.id,
          columnName: projection.atField,
          columnType: atColumn.type,
        }
      )
    }

    for (const [propertyId, mapping] of Object.entries(projection.properties)) {
      const property = properties.get(propertyId)
      if (!property) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Telemetry projection '${projection.id}' property '${propertyId}' was not validated before execution.`,
          { ...context, objectTypeId: objectType.id, propertyId }
        )
      }

      const valueColumn = requireColumn(columnsByName, mapping.valueField, context)
      if (
        !isDatasetColumnCompatibleWithSchema(
          valueColumn.type,
          property.schema,
          ontology.getValueTypesById(),
          {
            ...context,
            objectTypeId: objectType.id,
            propertyId,
            columnName: valueColumn.name,
          }
        )
      ) {
        throw invalidProjectionDefinition(
          `[SixbProjectionWorker] Telemetry projection '${projection.id}' maps dataset column '${valueColumn.name}' (${valueColumn.type}) to incompatible property '${propertyId}'.`,
          {
            ...context,
            objectTypeId: objectType.id,
            propertyId,
            columnName: valueColumn.name,
            columnType: valueColumn.type,
          }
        )
      }

      if (mapping.unitField !== undefined) {
        const unitColumn = requireColumn(columnsByName, mapping.unitField, context)
        if (unitColumn.type !== "string") {
          throw invalidProjectionDefinition(
            `[SixbProjectionWorker] Telemetry projection '${projection.id}' property '${propertyId}' unit field '${mapping.unitField}' must be a string dataset column.`,
            {
              ...context,
              objectTypeId: objectType.id,
              propertyId,
              columnName: mapping.unitField,
              columnType: unitColumn.type,
            }
          )
        }
      }
    }

    return
  }

  const sourceObjectType = requireObjectType(
    ontology,
    projection.sourceObjectTypeId,
    "source object type",
    context
  )
  requireObjectType(ontology, projection.targetObjectTypeId, "target object type", context)
  const linkDefinition = requireLink(sourceObjectType, projection.linkId, context)
  assertLinkTargetCompatible({
    ontology,
    context,
    link: linkDefinition,
    actualTargetObjectTypeId: projection.targetObjectTypeId,
  })

  const sourceColumn = requireColumn(columnsByName, projection.sourceField, context)
  const targetColumn = requireColumn(columnsByName, projection.targetField, context)

  if (sourceColumn.type !== "string" || targetColumn.type !== "string") {
    throw invalidProjectionDefinition(
      `[SixbProjectionWorker] Link projection '${projection.id}' source and target fields must be string dataset columns.`,
      {
        ...context,
        linkId: projection.linkId,
        sourceColumnName: sourceColumn.name,
        sourceColumnType: sourceColumn.type,
        targetColumnName: targetColumn.name,
        targetColumnType: targetColumn.type,
      }
    )
  }
}

function requireObjectType(
  ontology: OntologyDefinitionCatalog,
  objectTypeId: string,
  role: string,
  context: ProjectionValidationContext
): ObjectTypeWithPropertyTokens {
  const objectType = ontology.getObjectTypeById(objectTypeId)
  if (!objectType) {
    throw invalidProjectionDefinition(
      `[SixbProjectionWorker] Projection '${context.projectionId}' references unknown ${role} '${objectTypeId}'.`,
      { ...context, objectTypeId, role }
    )
  }
  return objectType
}

function requireProperty(
  objectType: ObjectTypeWithPropertyTokens,
  propertyId: string,
  role: string,
  context: ProjectionValidationContext
): Property {
  const property = objectType.properties.find((candidate) => candidate.id === propertyId)
  if (!property) {
    throw invalidProjectionDefinition(
      `[SixbProjectionWorker] Projection '${context.projectionId}' references unknown ${role} '${propertyId}' on object type '${objectType.id}'.`,
      { ...context, objectTypeId: objectType.id, propertyId, role }
    )
  }
  return property
}

function requireLink(
  objectType: ObjectTypeWithPropertyTokens,
  linkId: string,
  context: ProjectionValidationContext
): ObjectLink {
  const link = objectType.links.find((candidate) => candidate.id === linkId)
  if (!link) {
    throw invalidProjectionDefinition(
      `[SixbProjectionWorker] Projection '${context.projectionId}' references unknown link '${linkId}' on object type '${objectType.id}'.`,
      { ...context, objectTypeId: objectType.id, linkId }
    )
  }
  return link
}

function assertLinkTargetCompatible(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly context: ProjectionValidationContext
  readonly link: ObjectLink
  readonly actualTargetObjectTypeId: string
}): void {
  const { ontology, context, link, actualTargetObjectTypeId } = input
  if (ontology.isValidLinkTarget(link.targetObjectTypeId, actualTargetObjectTypeId)) {
    return
  }

  throw invalidProjectionDefinition(
    `[SixbProjectionWorker] Projection '${context.projectionId}' link '${link.id}' target type '${actualTargetObjectTypeId}' is not compatible with declared target '${formatTarget(link.targetObjectTypeId)}'.`,
    {
      ...context,
      linkId: link.id,
      actualTargetObjectTypeId,
      expectedTargetObjectTypeId: formatTarget(link.targetObjectTypeId),
    }
  )
}

function formatTarget(target: string | readonly string[]): string {
  return typeof target === "string" ? target : target.join(" | ")
}

function requireColumn(
  columnsByName: DatasetColumnsByName,
  columnName: string,
  context: ProjectionValidationContext
): DatasetColumnDefinition {
  const column = columnsByName.get(columnName)
  if (!column) {
    throw invalidProjectionDefinition(
      `[SixbProjectionWorker] Projection '${context.projectionId}' references unknown dataset column '${columnName}' on dataset '${context.datasetId}'.`,
      { ...context, columnName }
    )
  }
  return column
}

function projectionValidationContext(input: {
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readonly runId?: string
}): ProjectionValidationContext {
  return {
    projectionId: input.projection.id,
    datasetId: input.dataset.id,
    versionId: input.version.versionId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  }
}

function invalidProjectionDefinition(message: string, details: ProjectionErrorDetails) {
  return createSixbError("projection.definition_invalid", message, { details })
}

function incompatibleDatasetVersion(message: string, details: ProjectionErrorDetails) {
  return createSixbError("dataset.version_incompatible", message, { details })
}

function isDateLikeColumnType(type: DatasetColumnDefinition["type"]): boolean {
  return type === "string" || type === "date" || type === "timestamp"
}

function isDatasetColumnCompatibleWithSchema(
  columnType: DatasetColumnDefinition["type"],
  schema: Schema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  errorContext: ProjectionErrorDetails
): boolean {
  const resolved = resolveProjectionSchema(schema, valueTypesById, {
    code: "projection.definition_invalid",
    details: errorContext,
  })

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
