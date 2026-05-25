import {
  type DatasetColumnDefinition,
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  type ObjectProjectionDefinition,
  type OntologyRegistry,
  type Schema,
} from "@pario/core"
import { ProjectionWorkerError } from "./errors"
import { resolveProjectionSchema } from "./projection-schema"
import { normalizeProjectedValue } from "./projection-value-coercion"

export interface ObjectProjectionPlan {
  readonly projection: ObjectProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly primaryPropertyId: string
  readonly propertyPlans: ReadonlyMap<string, ProjectedPropertyPlan>
}

export interface ProjectedObjectRow {
  readonly properties: Record<string, unknown>
  readonly primaryValue: unknown
}

export type ProjectObjectRowResult =
  | {
      readonly ok: true
      readonly row: ProjectedObjectRow
    }
  | {
      readonly ok: false
      readonly errorMessage: string
    }

interface ProjectedPropertyPlan {
  readonly propertyId: string
  readonly columnName: string
  readonly columnType: DatasetColumnDefinition["type"]
  readonly schema: Schema
}

type CollectPropertiesResult =
  | {
      readonly ok: true
      readonly properties: Record<string, unknown>
    }
  | {
      readonly ok: false
      readonly errorMessage: string
    }

export function buildObjectProjectionPlan(input: {
  readonly ontology: OntologyRegistry
  readonly projection: ObjectProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly primaryPropertyId: string
}): ObjectProjectionPlan {
  const { ontology, projection, dataset, primaryPropertyId } = input

  return {
    projection,
    dataset,
    primaryPropertyId,
    propertyPlans: buildProjectedPropertyPlans({ ontology, projection, dataset }),
  }
}

export function projectObjectRow(plan: ObjectProjectionPlan, row: unknown): ProjectObjectRowResult {
  const { projection, dataset, primaryPropertyId, propertyPlans } = plan

  if (!isPlainObject(row)) {
    const validationError = getDatasetRowValidationError(row, dataset)
    return {
      ok: false,
      errorMessage: validationError ?? `Dataset '${dataset.id}' rows must be plain objects.`,
    }
  }

  const rowValidationError = getDatasetRowValidationError(row, dataset)
  if (rowValidationError) {
    return { ok: false, errorMessage: rowValidationError }
  }

  const collected = collectProperties(projection, row, propertyPlans)
  if (!collected.ok) {
    return collected
  }

  return {
    ok: true,
    row: {
      properties: collected.properties,
      primaryValue: collected.properties[primaryPropertyId],
    },
  }
}

function buildProjectedPropertyPlans(input: {
  readonly ontology: OntologyRegistry
  readonly projection: ObjectProjectionDefinition
  readonly dataset: DatasetDefinition
}): ReadonlyMap<string, ProjectedPropertyPlan> {
  const { ontology, projection, dataset } = input
  const objectType = ontology.getObjectTypeById(projection.objectTypeId)
  if (!objectType) {
    throw new ProjectionWorkerError(
      `[ParioProjectionWorker] Projection '${projection.id}' references unknown object type '${projection.objectTypeId}'.`
    )
  }

  const propertiesById = new Map(objectType.properties.map((property) => [property.id, property]))
  const columnsByName = new Map(dataset.schema.columns.map((column) => [column.name, column]))
  const valueTypesById = ontology.getValueTypesById()
  const propertyPlans = new Map<string, ProjectedPropertyPlan>()

  for (const [propertyId, columnName] of Object.entries(projection.properties)) {
    const property = propertiesById.get(propertyId)
    if (!property) {
      throw new ProjectionWorkerError(
        `[ParioProjectionWorker] Projection '${projection.id}' references unknown property '${propertyId}' on object type '${objectType.id}'.`
      )
    }

    const column = columnsByName.get(columnName)
    if (!column) {
      throw new ProjectionWorkerError(
        `[ParioProjectionWorker] Projection '${projection.id}' references unknown dataset column '${columnName}' on dataset '${dataset.id}'.`
      )
    }

    propertyPlans.set(propertyId, {
      propertyId,
      columnName,
      columnType: column.type,
      schema: resolveProjectionSchema(property.schema, valueTypesById),
    })
  }

  return propertyPlans
}

function collectProperties(
  projection: ObjectProjectionDefinition,
  row: DatasetRow,
  propertyPlans: ReadonlyMap<string, ProjectedPropertyPlan>
): CollectPropertiesResult {
  const properties: Record<string, unknown> = {}

  for (const [propertyId, columnName] of Object.entries(projection.properties)) {
    const value = row[columnName]
    if (value === null || value === undefined) {
      continue
    }

    const propertyPlan = propertyPlans.get(propertyId)
    if (!propertyPlan) {
      return {
        ok: false,
        errorMessage: `[ParioProjectionWorker] Projection '${projection.id}' has no property plan for '${propertyId}'.`,
      }
    }

    const normalized = normalizeProjectedValue({
      columnType: propertyPlan.columnType,
      schema: propertyPlan.schema,
      value,
    })
    if (!normalized.ok) {
      return {
        ok: false,
        errorMessage: `[ParioProjectionWorker] Projection '${projection.id}' property '${propertyId}' from dataset column '${columnName}' (${propertyPlan.columnType}) ${normalized.errorMessage}.`,
      }
    }

    properties[propertyId] = normalized.value
  }

  return { ok: true, properties }
}

function isPlainObject(value: unknown): value is DatasetRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
