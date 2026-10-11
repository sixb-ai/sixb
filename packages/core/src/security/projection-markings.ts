import type { DatasetVersion } from "../lake-storage/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectType } from "../ontology/types"
import type { ProjectionDefinitionCatalog } from "../projections/registry"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "../projections/types"
import type { VersionClassification } from "./dataset-version-markings"
import { SecurityValidationError } from "./errors"
import type { ColumnMarkingOrigins, DatasetMarkings, MarkingOrigin } from "./marking-propagation"

type OntologyLookup = Pick<OntologyDefinitionCatalog, "getObjectTypeById">

/** Markings of one column of the projection's dataset. */
type ColumnMarkingsLookup = (column: string) => readonly string[]

/** The first marking rule a projection breaks. */
type ProjectionMarkingViolation =
  | {
      readonly kind: "undeclared"
      readonly property: string
      readonly column: string
      readonly missing: readonly string[]
    }
  | { readonly kind: "markedKeyColumn"; readonly column: string; readonly role: string }
  | { readonly kind: "markedKeyProperty"; readonly property: string; readonly role: string }
  | { readonly kind: "telemetry"; readonly column: string }

/**
 * Objects are read through the ontology, so each projected property declares the markings of its
 * column: the ontology stays the reviewed contract of what each reader receives. Values that
 * identify objects or key links are returned wherever the object or link is, and telemetry does
 * not enforce markings yet, so those columns cannot carry markings.
 *
 * Startup checks it with the markings columns declare or inherit through `run` steps, and the
 * pipeline preflight with the markings SQL steps derive as well.
 */
export function validateProjectionMarkings(
  projections: ProjectionDefinitionCatalog,
  ontology: OntologyLookup,
  markings: DatasetMarkings
): void {
  const all = [
    ...projections.listObjects(),
    ...projections.listLinks(),
    ...projections.listTelemetry(),
  ]

  for (const projection of all) {
    const originsOf = (column: string) => markings.of({ datasetId: projection.datasetId, column })
    const violation = findProjectionMarkingViolation(projection, ontology, (column) => [
      ...originsOf(column).keys(),
    ])
    if (!violation) continue

    const carries = (column: string): CarriedMarkings => {
      const origins = originsOf(column)
      return {
        text: describeOrigins(origins, `${projection.datasetId}.${column}`),
        inherited: [...origins.values()].some((origin) => origin.steps.length > 0),
      }
    }

    throw new SecurityValidationError(
      violationMessage(
        `[Sixb] Projection '${projection.id}'`,
        projection.datasetId,
        violation,
        carries
      )
    )
  }
}

/**
 * Refuse to project a dataset version whose columns carry more markings than the projection
 * allows. A version keeps the markings of the code that produced it, so a version written before
 * the current code can carry markings startup did not see. Call it once per version, before
 * reading its rows; it reads nothing, so what it throws is a refusal that no retry changes.
 */
export function assertProjectionVersionMarkings(input: {
  readonly projection: ProjectionDefinition
  readonly ontology: OntologyLookup
  readonly version: DatasetVersion
  readonly classification: VersionClassification
}): void {
  const { projection, version, classification } = input
  const markingsOf = (column: string) => [...(classification.columns.get(column) ?? [])].sort()
  const violation = findProjectionMarkingViolation(projection, input.ontology, markingsOf)
  if (!violation) return

  const subject = `[Sixb] Projection '${projection.id}' cannot read version '${version.versionId}' of dataset '${version.datasetId}'`
  const carries = (column: string): CarriedMarkings => ({
    text: `${markingList(markingsOf(column))} in this version`,
    inherited: true,
  })
  const conservative =
    classification.conservative === undefined
      ? ""
      : ` The version was classified with every marking its sources could hold, because ${classification.conservative}.`
  const rerun = `If the code that writes '${version.datasetId}' no longer derives these markings, rerun its pipeline.`

  throw new Error(
    `${violationMessage(subject, version.datasetId, violation, carries)}${conservative} ${rerun}`
  )
}

// ── Rules ───────────────────────────────────────────────────

function findProjectionMarkingViolation(
  projection: ProjectionDefinition,
  ontology: OntologyLookup,
  markingsOf: ColumnMarkingsLookup
): ProjectionMarkingViolation | null {
  switch (projection._tag) {
    case "ObjectProjectionDefinition": {
      const objectType = ontology.getObjectTypeById(projection.objectTypeId)
      return objectType ? objectProjectionViolation(projection, objectType, markingsOf) : null
    }
    case "LinkProjectionDefinition":
      return linkProjectionViolation(projection, markingsOf)
    case "TelemetryProjectionDefinition":
      return telemetryProjectionViolation(projection, markingsOf)
  }
}

function objectProjectionViolation(
  projection: ObjectProjectionDefinition,
  objectType: ObjectType,
  markingsOf: ColumnMarkingsLookup
): ProjectionMarkingViolation | null {
  const keyRoles = objectProjectionKeyRoles(projection, objectType)

  for (const [propertyId, column] of Object.entries(projection.properties)) {
    const property = objectType.properties.find((candidate) => candidate.id === propertyId)
    const path = `${objectType.id}.${propertyId}`
    const keyRole = keyRoles.get(propertyId)

    if (keyRole) {
      if (markingsOf(column).length > 0) return { kind: "markedKeyColumn", column, role: keyRole }
      if (property?.markings) return { kind: "markedKeyProperty", property: path, role: keyRole }
      continue
    }

    const declared = new Set(property?.markings ?? [])
    const missing = markingsOf(column).filter((markingId) => !declared.has(markingId))
    if (missing.length > 0) return { kind: "undeclared", property: path, column, missing }
  }

  for (const [linkId, link] of Object.entries(projection.links)) {
    if (link.sourceField === undefined) continue

    const role = `keys link '${objectType.id}.${linkId}'`
    const violation = markedKeyColumn(link.sourceField, role, markingsOf)
    if (violation) return violation
  }

  // The timestamp decides whether the source value or an app edit wins, which reveals how they
  // compare.
  const conflictResolution = projection.conflictResolution
  if (conflictResolution?.strategy === "mostRecent") {
    const role = "decides which value wins under 'mostRecent'"
    return markedKeyColumn(conflictResolution.sourceTimestamp, role, markingsOf)
  }

  return null
}

function linkProjectionViolation(
  projection: LinkProjectionDefinition,
  markingsOf: ColumnMarkingsLookup
): ProjectionMarkingViolation | null {
  const role = `keys link '${projection.sourceObjectTypeId}.${projection.linkId}'`
  return (
    markedKeyColumn(projection.sourceField, role, markingsOf) ??
    markedKeyColumn(projection.targetField, role, markingsOf)
  )
}

function telemetryProjectionViolation(
  projection: TelemetryProjectionDefinition,
  markingsOf: ColumnMarkingsLookup
): ProjectionMarkingViolation | null {
  const columns = [
    projection.objectIdField,
    projection.atField,
    ...Object.values(projection.properties).flatMap((mapping) =>
      mapping.unitField === undefined
        ? [mapping.valueField]
        : [mapping.valueField, mapping.unitField]
    ),
  ]

  const column = columns.find((candidate) => markingsOf(candidate).length > 0)
  return column === undefined ? null : { kind: "telemetry", column }
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

function markedKeyColumn(
  column: string,
  role: string,
  markingsOf: ColumnMarkingsLookup
): ProjectionMarkingViolation | null {
  return markingsOf(column).length > 0 ? { kind: "markedKeyColumn", column, role } : null
}

// ── Messages ────────────────────────────────────────────────

/** What a column carries, for messages, and whether any of it comes from elsewhere. */
interface CarriedMarkings {
  readonly text: string
  readonly inherited: boolean
}

function violationMessage(
  subject: string,
  datasetId: string,
  violation: ProjectionMarkingViolation,
  carries: (column: string) => CarriedMarkings
): string {
  const path = (column: string) => `${datasetId}.${column}`

  switch (violation.kind) {
    case "undeclared":
      return `${subject}: property '${violation.property}' is projected from column '${path(violation.column)}', which carries ${carries(violation.column).text}. Add markings: ${markingList(violation.missing)} to the property.`
    case "markedKeyColumn": {
      const carried = carries(violation.column)
      const inherited = carried.inherited ? `, but carries ${carried.text}` : ""
      return `${subject}: column '${path(violation.column)}' ${violation.role} and cannot carry markings${inherited}.`
    }
    case "markedKeyProperty":
      return `${subject}: property '${violation.property}' ${violation.role} and cannot carry markings.`
    case "telemetry":
      return `${subject}: column '${path(violation.column)}' carries ${carries(violation.column).text}, and telemetry projections cannot read marked columns yet.`
  }
}

/**
 * `[financial] from 'raw_invoices.amount' through step 'invoices/normalize'`: each marking with one
 * path it arrived by. Markings the column declares itself have no path.
 */
export function describeOrigins(origins: ColumnMarkingOrigins, columnPath: string): string {
  const groups = new Map<string, string[]>()
  for (const [markingId, origin] of origins) {
    const path = originPath(origin, columnPath)
    groups.set(path, [...(groups.get(path) ?? []), markingId])
  }
  return [...groups].map(([path, markingIds]) => `${markingList(markingIds)}${path}`).join(" and ")
}

function originPath(origin: MarkingOrigin, columnPath: string): string {
  const source = `${origin.column.datasetId}.${origin.column.column}`
  if (origin.steps.length === 0 && source === columnPath) return ""

  const steps = origin.steps.map((step) => `'${step}'`).join(", ")
  return ` from '${source}' through ${origin.steps.length === 1 ? "step" : "steps"} ${steps}`
}

function markingList(markings: readonly string[]): string {
  return `[${markings.join(", ")}]`
}
