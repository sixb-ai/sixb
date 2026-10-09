import type { DatasetDefinition } from "../datasets/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectType, Property } from "../ontology/types"
import type { PipelineDefinition } from "../pipelines/types"
import type { ProjectionDefinitionCatalog } from "../projections/registry"
import type { ObjectProjectionDefinition } from "../projections/types"
import { SecurityValidationError } from "./errors"

/**
 * Check every marking once at startup.
 *
 * A marking is enforced at read time from the property or column definition alone, so each rule
 * here closes a path that would otherwise return the value unredacted or make enforcement
 * ambiguous.
 */
export function validateMarkingsAtStartup(input: {
  readonly markingIds: ReadonlySet<string>
  readonly ontology: OntologyDefinitionCatalog
  readonly datasetsById: ReadonlyMap<string, DatasetDefinition>
  readonly pipelines: readonly PipelineDefinition[]
  readonly projections: ProjectionDefinitionCatalog
}): void {
  validatePropertyMarkings(input.ontology, input.markingIds)
  validateColumnMarkings(input.datasetsById, input.markingIds)
  rejectPipelineStepsOverMarkedColumns(input.pipelines, input.datasetsById)
  validateProjectionMarkings(input.projections, input.ontology, input.datasetsById)
}

// ── Declarations ────────────────────────────────────────────

function validatePropertyMarkings(
  ontology: OntologyDefinitionCatalog,
  markingIds: ReadonlySet<string>
): void {
  for (const objectType of ontology.listObjectTypes()) {
    for (const property of objectType.properties) {
      validateProperty(objectType, property, markingIds)
    }
    for (const link of objectType.links) {
      for (const property of link.properties ?? []) {
        if (property.markings !== undefined) {
          throw new SecurityValidationError(
            `[Sixb] Link property '${objectType.id}.${link.id}.${property.id}' cannot carry markings. Mark object properties instead.`
          )
        }
      }
    }
    assertSubtypeKeepsParentMarkings(objectType, ontology)
  }
}

function validateProperty(
  objectType: ObjectType,
  property: Property,
  markingIds: ReadonlySet<string>
): void {
  if (property.markings === undefined) return
  const path = `${objectType.id}.${property.id}`
  assertMarkingList(property.markings, `Property '${path}'`, markingIds)

  // The primary id identifies the object in every response, link, and event.
  if (property.primary) {
    throw new SecurityValidationError(
      `[Sixb] Primary property '${path}' cannot carry markings: it identifies the object.`
    )
  }
  // Telemetry values also flow through history reads and telemetry events, which do not
  // enforce markings yet.
  if (property.mode === "telemetry") {
    throw new SecurityValidationError(
      `[Sixb] Telemetry property '${path}' cannot carry markings yet.`
    )
  }
}

/**
 * A subtype inherits its parent's properties and may redefine them. Subtype rows are returned by
 * parent-type reads, so a redefinition that dropped a marking would declassify the parent's data.
 */
function assertSubtypeKeepsParentMarkings(
  objectType: ObjectType,
  ontology: OntologyDefinitionCatalog
): void {
  if (!objectType.extends) return
  const parent = ontology.getObjectTypeById(objectType.extends)
  if (!parent) return

  for (const parentProperty of parent.properties) {
    const property = objectType.properties.find((candidate) => candidate.id === parentProperty.id)
    const missing = missingMarkings(parentProperty.markings, property?.markings)
    if (missing.length > 0) {
      throw new SecurityValidationError(
        `[Sixb] Property '${objectType.id}.${parentProperty.id}' must keep the markings of '${parent.id}.${parentProperty.id}': add ${missing.map((markingId) => `'${markingId}'`).join(", ")}.`
      )
    }
  }
}

function validateColumnMarkings(
  datasetsById: ReadonlyMap<string, DatasetDefinition>,
  markingIds: ReadonlySet<string>
): void {
  for (const dataset of datasetsById.values()) {
    for (const column of dataset.schema.columns) {
      if (column.markings === undefined) continue
      assertMarkingList(
        column.markings,
        `Dataset column '${dataset.id}.${column.name}'`,
        markingIds
      )
    }
  }
}

function assertMarkingList(
  markings: unknown,
  subject: string,
  markingIds: ReadonlySet<string>
): void {
  if (!Array.isArray(markings) || markings.length === 0) {
    throw new SecurityValidationError(
      `[Sixb] ${subject} markings must be a non-empty list of marking ids.`
    )
  }
  if (new Set(markings).size !== markings.length) {
    throw new SecurityValidationError(`[Sixb] ${subject} lists the same marking twice.`)
  }
  for (const markingId of markings) {
    if (typeof markingId !== "string" || !markingIds.has(markingId)) {
      throw new SecurityValidationError(
        `[Sixb] ${subject} references unknown marking '${String(markingId)}'. Add it to 'security/markings/' or pass it to createSixb({ markings }).`
      )
    }
  }
}

// ── Propagation ─────────────────────────────────────────────

/**
 * A step's output inherits nothing from its inputs until Sixb can derive each output column's
 * markings from the transform. Until then, reading a marked column would declassify it.
 */
function rejectPipelineStepsOverMarkedColumns(
  pipelines: readonly PipelineDefinition[],
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): void {
  for (const pipeline of pipelines) {
    for (const { step } of pipeline.graph.nodes) {
      for (const input of Object.values(step.inputs)) {
        const dataset = datasetsById.get(input.id)
        const column = dataset?.schema.columns.find((candidate) => candidate.markings)
        if (!dataset || !column) continue
        throw new SecurityValidationError(
          `[Sixb] Pipeline '${pipeline.id}' step '${step.id}' reads column '${dataset.id}.${column.name}', which carries ${markingList(column.markings)}. Pipeline steps cannot read marked columns yet.`
        )
      }
    }
  }
}

/**
 * Objects are read through the ontology, so each projected property declares the markings of its
 * column: the ontology stays the reviewed contract of what each reader receives. Values that
 * identify objects or key links are returned wherever the object or link is, and telemetry does
 * not enforce markings yet, so those columns cannot carry markings.
 */
function validateProjectionMarkings(
  projections: ProjectionDefinitionCatalog,
  ontology: OntologyDefinitionCatalog,
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): void {
  for (const projection of projections.listObjects()) {
    const objectType = ontology.getObjectTypeById(projection.objectTypeId)
    if (objectType) validateObjectProjection(projection, objectType, datasetsById)
  }

  for (const projection of projections.listLinks()) {
    const role = `keys link '${projection.sourceObjectTypeId}.${projection.linkId}'`
    for (const columnName of [projection.sourceField, projection.targetField]) {
      assertUnmarkedColumn(projection, sourceColumn(projection, columnName, datasetsById), role)
    }
  }

  for (const projection of projections.listTelemetry()) {
    const columnNames = [
      projection.objectIdField,
      projection.atField,
      ...Object.values(projection.properties).flatMap((mapping) =>
        mapping.unitField === undefined
          ? [mapping.valueField]
          : [mapping.valueField, mapping.unitField]
      ),
    ]
    for (const columnName of columnNames) {
      const column = sourceColumn(projection, columnName, datasetsById)
      if (!column.markings) continue
      throw new SecurityValidationError(
        `[Sixb] Projection '${projection.id}' reads column '${column.path}', which carries ${markingList(column.markings)}. Telemetry projections cannot read marked columns yet.`
      )
    }
  }
}

function validateObjectProjection(
  projection: ObjectProjectionDefinition,
  objectType: ObjectType,
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): void {
  const keyRoles = objectProjectionKeyRoles(projection, objectType)

  for (const [propertyId, columnName] of Object.entries(projection.properties)) {
    const column = sourceColumn(projection, columnName, datasetsById)
    const property = objectType.properties.find((candidate) => candidate.id === propertyId)
    const path = `${objectType.id}.${propertyId}`
    const keyRole = keyRoles.get(propertyId)
    if (keyRole) {
      assertUnmarkedColumn(projection, column, keyRole)
      if (property?.markings) {
        throw new SecurityValidationError(
          `[Sixb] Projection '${projection.id}': property '${path}' ${keyRole} and cannot carry markings.`
        )
      }
      continue
    }
    const missing = missingMarkings(column.markings, property?.markings)
    if (missing.length > 0) {
      throw new SecurityValidationError(
        `[Sixb] Projection '${projection.id}': property '${path}' is projected from column '${column.path}', which carries ${markingList(column.markings)}. Add markings: ${markingList(missing)} to the property.`
      )
    }
  }

  for (const [linkId, link] of Object.entries(projection.links)) {
    if (link.sourceField === undefined) continue
    assertUnmarkedColumn(
      projection,
      sourceColumn(projection, link.sourceField, datasetsById),
      `keys link '${objectType.id}.${linkId}'`
    )
  }

  // The timestamp decides whether the source value or an app edit wins, which reveals how they
  // compare.
  const conflictResolution = projection.conflictResolution
  if (conflictResolution?.strategy === "mostRecent") {
    assertUnmarkedColumn(
      projection,
      sourceColumn(projection, conflictResolution.sourceTimestamp, datasetsById),
      "decides which value wins under 'mostRecent'"
    )
  }
}

/** Properties whose value becomes an object id or a link key, with the role they play. */
function objectProjectionKeyRoles(
  projection: ObjectProjectionDefinition,
  objectType: ObjectType
): ReadonlyMap<string, string> {
  const roles = new Map<string, string>()
  for (const property of objectType.properties) {
    if (property.primary) roles.set(property.id, `becomes the id of '${objectType.id}'`)
  }
  for (const [linkId, link] of Object.entries(projection.links)) {
    if (link.sourcePropertyId === undefined) continue
    roles.set(link.sourcePropertyId, `keys link '${objectType.id}.${linkId}'`)
  }
  return roles
}

interface SourceColumn {
  readonly path: string
  readonly markings?: readonly string[]
}

function sourceColumn(
  projection: { readonly id: string; readonly datasetId: string },
  columnName: string,
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): SourceColumn {
  const column = datasetsById
    .get(projection.datasetId)
    ?.schema.columns.find((candidate) => candidate.name === columnName)
  // Projection validation runs first and resolves every mapped column.
  if (!column) {
    throw new Error(`[Sixb] Projection '${projection.id}' maps unknown column '${columnName}'.`)
  }
  return { path: `${projection.datasetId}.${columnName}`, markings: column.markings }
}

function assertUnmarkedColumn(
  projection: { readonly id: string },
  column: SourceColumn,
  role: string
): void {
  if (!column.markings) return
  throw new SecurityValidationError(
    `[Sixb] Projection '${projection.id}': column '${column.path}' ${role} and cannot carry markings.`
  )
}

// ── Helpers ─────────────────────────────────────────────────

function missingMarkings(
  required: readonly string[] | undefined,
  declared: readonly string[] | undefined
): readonly string[] {
  const present = new Set(declared ?? [])
  return (required ?? []).filter((markingId) => !present.has(markingId))
}

function markingList(markings: readonly string[] | undefined): string {
  return `[${(markings ?? []).join(", ")}]`
}
