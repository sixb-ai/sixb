import type { ProjectionEventOrigin } from "../events/envelope"
import type { DatasetVersion } from "../lake-storage/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { PipelineDefinition } from "../pipelines/types"
import type { LinkProjectionDefinition, ObjectProjectionDefinition } from "../projections/types"
import type { ActiveOntologySource, ActiveSourceTarget } from "../storage/ontology"
import { type AppliedContribution, NO_CONTRIBUTION } from "./applied-markings-snapshot"
import type { VersionClassification } from "./dataset-version-markings"
import { registeredSteps } from "./marking-propagation"
import { type ProjectionKeyTarget, projectionSurplus } from "./projection-markings"

export type SourceProjection = ObjectProjectionDefinition | LinkProjectionDefinition

/** What reading a projection's applied version from the lake gave. */
export type AppliedVersionRead =
  | {
      readonly kind: "read"
      readonly version: DatasetVersion
      readonly classification: VersionClassification
    }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: unknown }

export interface AppliedContributionContext {
  readonly ontology: Pick<OntologyDefinitionCatalog, "getObjectTypeById">
  /** The revision of a projection's current definition. */
  readonly revisionOf: (projectionId: string) => string
  /** What a version that cannot be read may carry. */
  readonly everyMarking: ReadonlySet<string>
  /** The pipeline that writes a dataset in the current code, for messages. */
  readonly pipelineOf: (datasetId: string) => string | undefined
}

/**
 * What one projection's applied version adds to the code's markings, with the notice that explains
 * it. It reads nothing: the caller reads and classifies the version.
 *
 * - A version that could not be read seals the projection's target with every marking.
 * - Objects written by an earlier definition, which may have mapped any column, seal it with every
 *   marking of the version.
 * - Otherwise a property keeps the markings its column carries beyond its declaration, and a key
 *   column that carries markings seals what it keys.
 */
export function appliedContribution(
  projection: SourceProjection,
  source: ActiveOntologySource,
  read: AppliedVersionRead,
  context: AppliedContributionContext
): AppliedContribution {
  const { datasetId, versionId } = source.datasetVersion
  const subject = `version '${versionId}' of '${datasetId}'`
  const target = projectionTarget(projection)
  const hint = rerunHint(datasetId, read.kind === "read" ? read.version : undefined, context)
  const every = [...context.everyMarking].sort()

  if (read.kind === "failed") {
    return sealed(projection.id, target, every, hint, {
      reason: `the ${subject} it applied, which could not be read from the lake,`,
      detail: `applied ${subject}, which could not be read from the lake: ${sentence(errorMessage(read.error))}`,
    })
  }
  if (read.kind === "missing") {
    return sealed(projection.id, target, every, hint, {
      reason: `the ${subject} it applied, which the lake no longer has,`,
      detail: `applied ${subject}, which the lake no longer has.`,
    })
  }

  const { columns, conservative } = read.classification
  const because =
    conservative === undefined
      ? ""
      : ` The version was classified with every marking its sources could hold, because ${conservative}.`
  if (
    datasetId !== projection.datasetId ||
    source.projectionRevision !== context.revisionOf(projection.id)
  ) {
    const markings = appliedVersionMarkings(read, context.everyMarking)
    return sealed(projection.id, target, markings, hint, {
      reason: `the ${subject} it applied under an earlier definition of the projection`,
      detail: `applied ${subject} under an earlier definition of the projection, and that version carries ${markingList(markings)}.${because}`,
    })
  }

  const markingsOf = (column: string) => [...(columns.get(column) ?? [])].sort()
  const surplus = projectionSurplus(projection, context.ontology, markingsOf)
  if (surplus.properties.length === 0 && surplus.keys.length === 0) return NO_CONTRIBUTION

  const column = (name: string) => `'${datasetId}.${name}'`
  const seals = surplus.keys.map((key) => ({
    target: key.target,
    seal: {
      projectionId: projection.id,
      markings: key.markings,
      reason: `in the version '${versionId}' it applied, column ${column(key.column)}, which ${key.role},`,
    },
  }))
  const details = [
    ...surplus.keys.map(
      (key) => `column ${column(key.column)} ${key.role} and carries ${markingList(key.markings)}`
    ),
    ...surplus.properties.map(
      (property) =>
        `property '${property.objectTypeId}.${property.propertyId}' is projected from column ${column(property.column)}, which carries ${markingList(property.markings)}`
    ),
  ]
  const consequences: string[] = []
  if (seals.length > 0) {
    const markings = [...new Set(seals.flatMap(({ seal }) => seal.markings))].sort()
    consequences.push(
      `${describeTargets(seals.map(({ target }) => target))} cannot be read without clearance for ${markingList(markings)}`
    )
  }
  if (surplus.properties.length > 0) {
    const names = surplus.properties.map((p) => `'${p.objectTypeId}.${p.propertyId}'`)
    const verb = surplus.properties.length === 1 ? "keeps" : "keep"
    consequences.push(`${describeNames(names)} ${verb} these markings`)
  }
  return {
    properties: surplus.properties.map(({ objectTypeId, propertyId, markings }) => ({
      objectTypeId,
      propertyId,
      markings,
    })),
    seals,
    notice: {
      projectionId: projection.id,
      sealed: seals.length > 0,
      message: `[Sixb] Projection '${projection.id}' applied ${subject}, in which ${details.join("; ")}.${because} ${capitalize(consequences.join(", and "))} until the projection applies a version the code allows. ${hint}`,
    },
  }
}

/** Every marking the version carries in any column; every marking when it could not be read. */
export function appliedVersionMarkings(
  read: AppliedVersionRead,
  everyMarking: ReadonlySet<string>
): readonly string[] {
  if (read.kind !== "read") return [...everyMarking].sort()
  const { columns } = read.classification
  return [...new Set([...columns.values()].flatMap((set) => [...set]))].sort()
}

/**
 * A source whose projection the code no longer declares. No definition says which columns it
 * mapped, so what it wrote, read from the source itself (`target`), is sealed with every marking
 * its version carries, as objects an earlier definition wrote are.
 */
export function removedProjectionContribution(
  source: ActiveOntologySource,
  target: ActiveSourceTarget | null,
  markings: readonly string[]
): AppliedContribution {
  if (target === null) return NO_CONTRIBUTION
  const projectionId = source.source.projectionId
  const { datasetId, versionId } = source.datasetVersion
  const subject = `version '${versionId}' of '${datasetId}'`
  return sealed(
    projectionId,
    target.kind === "object"
      ? { kind: "type", objectTypeId: target.objectTypeId }
      : {
          kind: "link",
          objectTypeId: target.sourceTypeId,
          linkId: target.linkId,
          targetObjectTypeId: target.targetTypeId,
        },
    markings,
    `Declare projection '${projectionId}' again to replace it.`,
    {
      reason: `the ${subject} it applied, though the code no longer declares it,`,
      detail: `applied ${subject}, the code no longer declares it, and that version carries ${markingList([...markings])}.`,
    }
  )
}

/** An object event a projection emitted: the version its values came from, and its type. */
export type EventOriginRef = Pick<
  ProjectionEventOrigin,
  "projectionId" | "datasetId" | "datasetVersionId"
> & { readonly objectTypeId: string }

/**
 * The markings an object event's origin version carries on each property its projection maps.
 * Without a definition that maps that version's dataset to the event's type, every property but
 * the primary one carries every marking of the version, as for objects of a removed projection.
 */
export function eventOriginMarkings(
  projection: ObjectProjectionDefinition | undefined,
  origin: EventOriginRef,
  read: AppliedVersionRead,
  context: Pick<AppliedContributionContext, "ontology" | "everyMarking">
): AppliedContribution["properties"] {
  const { objectTypeId } = origin
  if (
    read.kind === "read" &&
    projection?.datasetId === origin.datasetId &&
    projection.objectTypeId === objectTypeId
  ) {
    const { columns } = read.classification
    return Object.entries(projection.properties).flatMap(([propertyId, column]) => {
      const markings = [...(columns.get(column) ?? [])].sort()
      return markings.length === 0 ? [] : [{ objectTypeId, propertyId, markings }]
    })
  }
  const markings = appliedVersionMarkings(read, context.everyMarking)
  if (markings.length === 0) return []
  return (context.ontology.getObjectTypeById(objectTypeId)?.properties ?? [])
    .filter((property) => !property.primary)
    .map((property) => ({ objectTypeId, propertyId: property.id, markings }))
}

/** The pipeline that writes each dataset in the current code. */
export function producingPipelines(
  pipelines: readonly PipelineDefinition[]
): (datasetId: string) => string | undefined {
  const byDataset = new Map<string, string>()
  for (const { pipelineId, step } of registeredSteps(pipelines)) {
    if (!byDataset.has(step.output.id)) byDataset.set(step.output.id, pipelineId)
  }
  return (datasetId) => byDataset.get(datasetId)
}

/** Seal the projection's whole target: its object type, or its link. */
function sealed(
  projectionId: string,
  target: ProjectionKeyTarget,
  markings: readonly string[],
  hint: string,
  text: { readonly reason: string; readonly detail: string }
): AppliedContribution {
  if (markings.length === 0) return NO_CONTRIBUTION
  return {
    properties: [],
    seals: [{ target, seal: { projectionId, markings, reason: text.reason } }],
    notice: {
      projectionId,
      sealed: true,
      message: `[Sixb] Projection '${projectionId}' ${text.detail} ${describeTargets([target])} cannot be read without clearance for ${markingList(markings)} until the projection applies a version the code allows. ${hint}`,
    },
  }
}

function projectionTarget(projection: SourceProjection): ProjectionKeyTarget {
  return projection._tag === "ObjectProjectionDefinition"
    ? { kind: "type", objectTypeId: projection.objectTypeId }
    : {
        kind: "link",
        objectTypeId: projection.sourceObjectTypeId,
        linkId: projection.linkId,
        targetObjectTypeId: projection.targetObjectTypeId,
      }
}

function rerunHint(
  datasetId: string,
  version: DatasetVersion | undefined,
  context: AppliedContributionContext
): string {
  const pipelineId =
    context.pipelineOf(datasetId) ??
    (version?.producer?.kind === "pipeline" ? version.producer.id : undefined)
  return pipelineId === undefined
    ? `Write a new version of '${datasetId}' to replace it.`
    : `Rerun pipeline '${pipelineId}' to replace it.`
}

function describeTargets(targets: readonly ProjectionKeyTarget[]): string {
  return describeNames(
    targets.map((target) =>
      target.kind === "type"
        ? `'${target.objectTypeId}'`
        : `link '${target.objectTypeId}.${target.linkId}'`
    )
  )
}

function describeNames(names: readonly string[]): string {
  const unique = [...new Set(names)]
  const last = unique.pop() ?? ""
  return unique.length === 0 ? last : `${unique.join(", ")} and ${last}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`
}

function markingList(markings: readonly string[]): string {
  return `[${markings.join(", ")}]`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
