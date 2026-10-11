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

/** What a marked key column makes unreadable: the objects it identifies, or the link it keys. */
export type ProjectionKeyTarget =
  | { readonly kind: "type"; readonly objectTypeId: string }
  | {
      readonly kind: "link"
      readonly objectTypeId: string
      readonly linkId: string
      readonly targetObjectTypeId: string
    }

/** A marking rule a projection breaks. */
type ProjectionMarkingViolation =
  | {
      readonly kind: "undeclared"
      readonly property: string
      readonly objectTypeId: string
      readonly propertyId: string
      readonly column: string
      readonly missing: readonly string[]
    }
  | {
      readonly kind: "markedKeyColumn"
      readonly column: string
      readonly role: string
      readonly targets: readonly ProjectionKeyTarget[]
      /** The property the column fills, when the key is a property. */
      readonly property?: { readonly objectTypeId: string; readonly propertyId: string }
    }
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
    const violation = firstViolation(projection, ontology, (column) => [
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
  const violation = firstViolation(projection, input.ontology, markingsOf)
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

/** Markings an applied version gives a projection's targets beyond what the ontology declares. */
export interface ProjectionSurplus {
  /** Markings a mapped column carries that its property does not declare. */
  readonly properties: readonly {
    readonly objectTypeId: string
    readonly propertyId: string
    readonly column: string
    readonly markings: readonly string[]
  }[]
  /** Marked key columns, with what each one makes unreadable and why. */
  readonly keys: readonly {
    readonly target: ProjectionKeyTarget
    readonly column: string
    readonly role: string
    readonly markings: readonly string[]
  }[]
}

/**
 * What a projection's targets carry beyond their declarations when read from columns with these
 * markings: every rule it breaks, as markings to add to properties and to key targets. A property
 * that keys a link keeps its markings on the property as well.
 */
export function projectionSurplus(
  projection: ProjectionDefinition,
  ontology: OntologyLookup,
  markingsOf: ColumnMarkingsLookup
): ProjectionSurplus {
  const properties: ProjectionSurplus["properties"][number][] = []
  const keys: ProjectionSurplus["keys"][number][] = []
  for (const violation of projectionMarkingViolations(projection, ontology, markingsOf)) {
    switch (violation.kind) {
      case "undeclared":
        properties.push({
          objectTypeId: violation.objectTypeId,
          propertyId: violation.propertyId,
          column: violation.column,
          markings: violation.missing,
        })
        break
      case "markedKeyColumn": {
        const markings = markingsOf(violation.column)
        for (const target of violation.targets) {
          keys.push({ target, column: violation.column, role: violation.role, markings })
        }
        const property = violation.property
        if (property && violation.targets.some((target) => target.kind === "link")) {
          properties.push({ ...property, column: violation.column, markings })
        }
        break
      }
      // Startup refuses a marked key property and a marked telemetry column from the code alone.
      case "markedKeyProperty":
      case "telemetry":
        break
    }
  }
  return { properties, keys }
}

// ── Rules ───────────────────────────────────────────────────

function firstViolation(
  projection: ProjectionDefinition,
  ontology: OntologyLookup,
  markingsOf: ColumnMarkingsLookup
): ProjectionMarkingViolation | null {
  const first = projectionMarkingViolations(projection, ontology, markingsOf).next()
  return first.done ? null : first.value
}

/** Every marking rule the projection breaks, the first one being the one messages report. */
function* projectionMarkingViolations(
  projection: ProjectionDefinition,
  ontology: OntologyLookup,
  markingsOf: ColumnMarkingsLookup
): Generator<ProjectionMarkingViolation> {
  switch (projection._tag) {
    case "ObjectProjectionDefinition": {
      const objectType = ontology.getObjectTypeById(projection.objectTypeId)
      if (objectType) yield* objectProjectionViolations(projection, objectType, markingsOf)
      return
    }
    case "LinkProjectionDefinition":
      yield* linkProjectionViolations(projection, markingsOf)
      return
    case "TelemetryProjectionDefinition":
      yield* telemetryProjectionViolations(projection, markingsOf)
      return
  }
}

function* objectProjectionViolations(
  projection: ObjectProjectionDefinition,
  objectType: ObjectType,
  markingsOf: ColumnMarkingsLookup
): Generator<ProjectionMarkingViolation> {
  const keyRoles = objectProjectionKeyRoles(projection, objectType)

  for (const [propertyId, column] of Object.entries(projection.properties)) {
    const property = objectType.properties.find((candidate) => candidate.id === propertyId)
    const path = `${objectType.id}.${propertyId}`
    const keyRole = keyRoles.get(propertyId)
    if (keyRole) {
      if (markingsOf(column).length > 0) {
        yield {
          kind: "markedKeyColumn",
          column,
          role: keyRole.role,
          targets: keyRole.targets,
          property: { objectTypeId: objectType.id, propertyId },
        }
      } else if (property?.markings) {
        yield { kind: "markedKeyProperty", property: path, role: keyRole.role }
      }
      continue
    }
    const declared = new Set(property?.markings ?? [])
    const missing = markingsOf(column).filter((markingId) => !declared.has(markingId))
    if (missing.length > 0) {
      yield {
        kind: "undeclared",
        property: path,
        objectTypeId: objectType.id,
        propertyId,
        column,
        missing,
      }
    }
  }

  for (const [linkId, link] of Object.entries(projection.links)) {
    if (link.sourceField === undefined) continue
    const role = `keys link '${objectType.id}.${linkId}'`
    const target = linkTarget(objectType.id, linkId, link.targetObjectTypeId)
    yield* markedKeyColumn(link.sourceField, role, [target], markingsOf)
  }

  // The timestamp decides whether the source value or an app edit wins, which reveals how they
  // compare.
  const conflictResolution = projection.conflictResolution
  if (conflictResolution?.strategy === "mostRecent") {
    const role = "decides which value wins under 'mostRecent'"
    const target: ProjectionKeyTarget = { kind: "type", objectTypeId: objectType.id }
    yield* markedKeyColumn(conflictResolution.sourceTimestamp, role, [target], markingsOf)
  }
}

function* linkProjectionViolations(
  projection: LinkProjectionDefinition,
  markingsOf: ColumnMarkingsLookup
): Generator<ProjectionMarkingViolation> {
  const role = `keys link '${projection.sourceObjectTypeId}.${projection.linkId}'`
  const targets = [
    linkTarget(projection.sourceObjectTypeId, projection.linkId, projection.targetObjectTypeId),
  ]
  yield* markedKeyColumn(projection.sourceField, role, targets, markingsOf)
  yield* markedKeyColumn(projection.targetField, role, targets, markingsOf)
}

function* telemetryProjectionViolations(
  projection: TelemetryProjectionDefinition,
  markingsOf: ColumnMarkingsLookup
): Generator<ProjectionMarkingViolation> {
  const columns = [
    projection.objectIdField,
    projection.atField,
    ...Object.values(projection.properties).flatMap((mapping) =>
      mapping.unitField === undefined
        ? [mapping.valueField]
        : [mapping.valueField, mapping.unitField]
    ),
  ]
  for (const column of columns) {
    if (markingsOf(column).length > 0) yield { kind: "telemetry", column }
  }
}

interface KeyRole {
  readonly role: string
  readonly targets: readonly ProjectionKeyTarget[]
}

/** Properties whose value becomes an object id or a link key, with the role they play. */
function objectProjectionKeyRoles(
  projection: ObjectProjectionDefinition,
  objectType: ObjectType
): ReadonlyMap<string, KeyRole> {
  const roles = new Map<string, KeyRole>()
  for (const property of objectType.properties) {
    if (!property.primary) continue
    roles.set(property.id, {
      role: `becomes the id of '${objectType.id}'`,
      targets: [{ kind: "type", objectTypeId: objectType.id }],
    })
  }
  for (const [linkId, link] of Object.entries(projection.links)) {
    if (link.sourcePropertyId === undefined) continue
    // An id that also keys a link plays both roles; messages name the link.
    roles.set(link.sourcePropertyId, {
      role: `keys link '${objectType.id}.${linkId}'`,
      targets: [
        ...(roles.get(link.sourcePropertyId)?.targets ?? []),
        linkTarget(objectType.id, linkId, link.targetObjectTypeId),
      ],
    })
  }
  return roles
}

function linkTarget(
  objectTypeId: string,
  linkId: string,
  targetObjectTypeId: string
): ProjectionKeyTarget {
  return { kind: "link", objectTypeId, linkId, targetObjectTypeId }
}

function* markedKeyColumn(
  column: string,
  role: string,
  targets: readonly ProjectionKeyTarget[],
  markingsOf: ColumnMarkingsLookup
): Generator<ProjectionMarkingViolation> {
  if (markingsOf(column).length > 0) yield { kind: "markedKeyColumn", column, role, targets }
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
