import type { DatasetDefinition } from "../datasets"
import type { OntologyRegistry } from "../ontology"
import { categorizeProjections } from "./builders"
import { ProjectionValidationError } from "./errors"
import { computeProjectionOwnership } from "./ownership"
import {
  computeOntologyRevision,
  computeProjectionOwnershipHash,
  computeProjectionRevision,
} from "./revision"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  ResolvedProjection,
  TelemetryProjectionDefinition,
} from "./types"
import { validateProjectionsAtStartup } from "./validation"

type SourceProjectionDefinition = ObjectProjectionDefinition | LinkProjectionDefinition

export class ProjectionRegistry {
  readonly ontologyRevision: string
  private readonly sourceById = new Map<string, ResolvedProjection<SourceProjectionDefinition>>()
  private readonly telemetryById = new Map<
    string,
    ResolvedProjection<TelemetryProjectionDefinition>
  >()

  constructor(input: {
    readonly projections: readonly ProjectionDefinition[]
    readonly ontology: OntologyRegistry
    readonly datasetsById: ReadonlyMap<string, DatasetDefinition>
  }) {
    const ids = new Set<string>()
    for (const projection of input.projections) {
      if (ids.has(projection.id)) {
        throw new ProjectionValidationError(`[Sixb] Duplicate projection id: ${projection.id}`)
      }
      ids.add(projection.id)
    }

    const { objectProjections, linkProjections, telemetryProjections } = categorizeProjections(
      input.projections
    )
    validateProjectionsAtStartup(
      objectProjections,
      linkProjections,
      telemetryProjections,
      input.ontology,
      input.datasetsById
    )
    this.ontologyRevision = computeOntologyRevision(input.ontology)

    for (const projection of input.projections) {
      const dataset = input.datasetsById.get(projection.datasetId)
      if (!dataset) {
        throw new ProjectionValidationError(
          `[Sixb] Projection '${projection.id}' references unknown dataset '${projection.datasetId}'.`
        )
      }
      const ownership = computeProjectionOwnership(projection, input.ontology)
      const resolved = deepFreeze({
        projectionId: projection.id,
        datasetId: projection.datasetId,
        projectionRevision: computeProjectionRevision(projection, dataset),
        ownershipHash: computeProjectionOwnershipHash(ownership),
        ownership,
        definition: cloneProjectionDefinition(projection),
      })
      if (projection._tag === "TelemetryProjectionDefinition") {
        this.telemetryById.set(
          projection.id,
          resolved as ResolvedProjection<TelemetryProjectionDefinition>
        )
      } else {
        this.sourceById.set(
          projection.id,
          resolved as ResolvedProjection<SourceProjectionDefinition>
        )
      }
    }
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

function cloneProjectionDefinition(projection: ProjectionDefinition): ProjectionDefinition {
  if (projection._tag === "ObjectProjectionDefinition") {
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
            ...(descriptor.sourceField !== undefined
              ? { sourceField: descriptor.sourceField }
              : {}),
            targetObjectTypeId: descriptor.targetObjectTypeId,
          },
        ])
      ),
    }
  }
  if (projection._tag === "LinkProjectionDefinition") {
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
