import type { DatasetDefinition } from "../datasets"
import type { OntologyRegistry } from "../ontology"
import { isProjectionDefinition } from "./builders"
import { ProjectionValidationError } from "./errors"
import {
  computeOntologyRevision,
  computeProjectionOwnershipHash,
  computeProjectionRevision,
} from "./revision"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  ProjectionDispatchDescriptor,
  ResolvedProjection,
  TelemetryProjectionDefinition,
} from "./types"
import { type ValidatedProjectionRecord, validateProjectionsAtStartup } from "./validation"

type SourceProjectionDefinition = ObjectProjectionDefinition | LinkProjectionDefinition

/** Public definition catalog backed by the host's validated projection registry. */
export interface ProjectionDefinitionCatalog {
  list(): readonly ProjectionDefinition[]
  listObjects(): readonly ObjectProjectionDefinition[]
  listLinks(): readonly LinkProjectionDefinition[]
  listTelemetry(): readonly TelemetryProjectionDefinition[]
  getById(projectionId: string): ProjectionDefinition | null
}

export class ProjectionRegistry implements ProjectionDefinitionCatalog {
  readonly ontologyRevision: string
  private readonly objectProjections: readonly ObjectProjectionDefinition[]
  private readonly linkProjections: readonly LinkProjectionDefinition[]
  private readonly telemetryProjections: readonly TelemetryProjectionDefinition[]
  private readonly projectionsById = new Map<string, ProjectionDefinition>()
  private readonly sourceById = new Map<string, ResolvedProjection<SourceProjectionDefinition>>()
  private readonly telemetryById = new Map<
    string,
    ResolvedProjection<TelemetryProjectionDefinition>
  >()
  private readonly dispatchById = new Map<string, ProjectionDispatchDescriptor>()
  private readonly dispatchDescriptors: readonly ProjectionDispatchDescriptor[]

  constructor(input: {
    readonly projections: readonly ProjectionDefinition[]
    readonly ontology: OntologyRegistry
    readonly datasetsById: ReadonlyMap<string, DatasetDefinition>
  }) {
    const objectProjections: ObjectProjectionDefinition[] = []
    const linkProjections: LinkProjectionDefinition[] = []
    const telemetryProjections: TelemetryProjectionDefinition[] = []
    for (const projection of input.projections) {
      if (!isProjectionDefinition(projection)) {
        throw new ProjectionValidationError("[Sixb] Invalid projection definition.")
      }
      switch (projection._tag) {
        case "ObjectProjectionDefinition":
          objectProjections.push(deepFreeze(cloneObjectProjectionDefinition(projection)))
          break
        case "LinkProjectionDefinition":
          linkProjections.push(deepFreeze(cloneLinkProjectionDefinition(projection)))
          break
        case "TelemetryProjectionDefinition":
          telemetryProjections.push(deepFreeze(cloneTelemetryProjectionDefinition(projection)))
          break
      }
    }
    this.objectProjections = Object.freeze(objectProjections)
    this.linkProjections = Object.freeze(linkProjections)
    this.telemetryProjections = Object.freeze(telemetryProjections)

    const projections = [
      ...this.objectProjections,
      ...this.linkProjections,
      ...this.telemetryProjections,
    ]
    assertUniqueProjectionIds(projections)
    const validated = validateProjectionsAtStartup(
      {
        objectProjections: this.objectProjections,
        linkProjections: this.linkProjections,
        telemetryProjections: this.telemetryProjections,
      },
      input.ontology,
      input.datasetsById
    )
    this.ontologyRevision = computeOntologyRevision(input.ontology)

    const dispatchDescriptors: ProjectionDispatchDescriptor[] = []
    for (const record of validated.objectProjections) {
      const resolved = createResolvedProjection(record)
      this.sourceById.set(resolved.projectionId, resolved)
      this.projectionsById.set(resolved.projectionId, resolved.definition)
      dispatchDescriptors.push(createDispatchDescriptor(resolved, this.ontologyRevision))
    }
    for (const record of validated.linkProjections) {
      const resolved = createResolvedProjection(record)
      this.sourceById.set(resolved.projectionId, resolved)
      this.projectionsById.set(resolved.projectionId, resolved.definition)
      dispatchDescriptors.push(createDispatchDescriptor(resolved, this.ontologyRevision))
    }
    for (const record of validated.telemetryProjections) {
      const resolved = createResolvedProjection(record)
      this.telemetryById.set(resolved.projectionId, resolved)
      this.projectionsById.set(resolved.projectionId, resolved.definition)
      dispatchDescriptors.push(createDispatchDescriptor(resolved, this.ontologyRevision))
    }
    this.dispatchDescriptors = Object.freeze(dispatchDescriptors)
    for (const descriptor of this.dispatchDescriptors) {
      this.dispatchById.set(descriptor.projectionId, descriptor)
    }
  }

  list(): readonly ProjectionDefinition[] {
    return [...this.objectProjections, ...this.linkProjections, ...this.telemetryProjections]
  }

  listObjects(): readonly ObjectProjectionDefinition[] {
    return this.objectProjections
  }

  listLinks(): readonly LinkProjectionDefinition[] {
    return this.linkProjections
  }

  listTelemetry(): readonly TelemetryProjectionDefinition[] {
    return this.telemetryProjections
  }

  getById(projectionId: string): ProjectionDefinition | null {
    return this.projectionsById.get(projectionId) ?? null
  }

  getDispatchDescriptors(): readonly ProjectionDispatchDescriptor[] {
    return this.dispatchDescriptors
  }

  resolveDispatch(projectionId: string): ProjectionDispatchDescriptor {
    const descriptor = this.dispatchById.get(projectionId)
    if (descriptor) return descriptor
    throw new ProjectionValidationError(`[Sixb] Unknown projection '${projectionId}'.`)
  }

  resolveSource(projectionId: string): ResolvedProjection<SourceProjectionDefinition> {
    const resolved = this.sourceById.get(projectionId)
    if (!resolved) {
      if (this.telemetryById.has(projectionId)) {
        throw new ProjectionValidationError(
          `[Sixb] Projection '${projectionId}' is telemetry-only and cannot replace source state.`
        )
      }
      throw new ProjectionValidationError(`[Sixb] Unknown source projection '${projectionId}'.`)
    }
    return resolved
  }

  resolveTelemetry(projectionId: string): ResolvedProjection<TelemetryProjectionDefinition> {
    const resolved = this.telemetryById.get(projectionId)
    if (!resolved) {
      if (this.sourceById.has(projectionId)) {
        throw new ProjectionValidationError(
          `[Sixb] Projection '${projectionId}' does not own a telemetry source.`
        )
      }
      throw new ProjectionValidationError(`[Sixb] Unknown telemetry projection '${projectionId}'.`)
    }
    return resolved
  }
}

function createDispatchDescriptor(
  resolved: ResolvedProjection<ProjectionDefinition>,
  ontologyRevision: string
): ProjectionDispatchDescriptor {
  const common = {
    projectionId: resolved.projectionId,
    datasetId: resolved.datasetId,
    ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }

  switch (resolved.definition._tag) {
    case "ObjectProjectionDefinition":
      return deepFreeze({ ...common, projectionKind: "object", protocol: "replacement" })
    case "LinkProjectionDefinition":
      return deepFreeze({ ...common, projectionKind: "link", protocol: "replacement" })
    case "TelemetryProjectionDefinition":
      return deepFreeze({ ...common, projectionKind: "telemetry", protocol: "telemetry" })
  }
}

function assertUniqueProjectionIds(projections: readonly ProjectionDefinition[]): void {
  const ids = new Set<string>()
  for (const projection of projections) {
    if (ids.has(projection.id)) {
      throw new ProjectionValidationError(`[Sixb] Duplicate projection id: ${projection.id}`)
    }
    ids.add(projection.id)
  }
}

function createResolvedProjection<TDefinition extends ProjectionDefinition>(
  validated: ValidatedProjectionRecord<TDefinition>
): ResolvedProjection<TDefinition> {
  const { definition, dataset, ownership } = validated
  return deepFreeze({
    projectionId: definition.id,
    datasetId: definition.datasetId,
    projectionRevision: computeProjectionRevision(definition, dataset),
    ownershipHash: computeProjectionOwnershipHash(ownership),
    ownership,
    definition,
  })
}

// Projection builders may attach fluent methods and callers may supply extra fields. Clone only the
// frozen contract so resolved definitions stay serializable and cannot leak unsupported metadata.
function cloneObjectProjectionDefinition(
  projection: ObjectProjectionDefinition
): ObjectProjectionDefinition {
  return {
    _tag: projection._tag,
    id: projection.id,
    objectTypeId: projection.objectTypeId,
    datasetId: projection.datasetId,
    properties: { ...projection.properties },
    links: Object.fromEntries(
      Object.entries(projection.links).map(([linkId, descriptor]) => [
        linkId,
        {
          linkId: descriptor.linkId,
          ...(descriptor.sourcePropertyId !== undefined
            ? { sourcePropertyId: descriptor.sourcePropertyId }
            : {}),
          ...(descriptor.sourceField !== undefined ? { sourceField: descriptor.sourceField } : {}),
          targetObjectTypeId: descriptor.targetObjectTypeId,
        },
      ])
    ),
  }
}

function cloneLinkProjectionDefinition(
  projection: LinkProjectionDefinition
): LinkProjectionDefinition {
  return {
    _tag: "LinkProjectionDefinition",
    id: projection.id,
    linkId: projection.linkId,
    sourceObjectTypeId: projection.sourceObjectTypeId,
    targetObjectTypeId: projection.targetObjectTypeId,
    datasetId: projection.datasetId,
    sourceField: projection.sourceField,
    targetField: projection.targetField,
  }
}

function cloneTelemetryProjectionDefinition(
  projection: TelemetryProjectionDefinition
): TelemetryProjectionDefinition {
  return {
    _tag: "TelemetryProjectionDefinition",
    id: projection.id,
    objectTypeId: projection.objectTypeId,
    propertyId: projection.propertyId,
    datasetId: projection.datasetId,
    objectIdField: projection.objectIdField,
    atField: projection.atField,
    valueField: projection.valueField,
    ...(projection.unitField !== undefined ? { unitField: projection.unitField } : {}),
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}
