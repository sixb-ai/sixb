import type { DatasetDefinition } from "../datasets/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectType, Property } from "../ontology/types"
import type { PipelineDefinition } from "../pipelines/types"
import type { ProjectionDefinitionCatalog } from "../projections/registry"
import { SecurityValidationError } from "./errors"
import { MarkingPropagation, registeredSteps, runStepLineages } from "./marking-propagation"
import { validateProjectionMarkings } from "./projection-markings"

/**
 * Check every marking once at startup.
 *
 * A marking is enforced at read time from the property or column definition and the lineage of
 * the version read, so each rule here closes a path that would otherwise return the value
 * unredacted or make enforcement ambiguous.
 *
 * Projections are checked against the markings columns declare or inherit through `run` steps.
 * What SQL steps derive needs the lake provider's analysis, which `checkPipelineMarkings` adds.
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
  const runLineageOf = runStepLineages(input.datasetsById)
  const markings = new MarkingPropagation(
    input.datasetsById,
    registeredSteps(input.pipelines)
  ).derive((entry) => runLineageOf(entry) ?? null)
  validateProjectionMarkings(input.projections, input.ontology, markings)
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

  // Indexed on the first marked parent property: most parents mark nothing.
  let propertiesById: Map<string, Property> | undefined
  for (const parentProperty of parent.properties) {
    const parentMarkings = parentProperty.markings
    if (!parentMarkings) continue
    if (!propertiesById) {
      propertiesById = new Map()
      for (const property of objectType.properties) {
        if (!propertiesById.has(property.id)) propertiesById.set(property.id, property)
      }
    }
    const missing = missingMarkings(parentMarkings, propertiesById.get(parentProperty.id)?.markings)
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

function missingMarkings(
  required: readonly string[] | undefined,
  declared: readonly string[] | undefined
): readonly string[] {
  const present = new Set(declared ?? [])
  return (required ?? []).filter((markingId) => !present.has(markingId))
}
