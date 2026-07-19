import { MaterializationConflictError } from "../../materialization/errors"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import type { ProjectionMaterializationRunRecord } from "../../storage"

export function assertProjectionRunTargets(
  run: ProjectionMaterializationRunRecord,
  resolved: ResolvedProjection<ProjectionDefinition>
): void {
  if (projectionRunTargetsMatch(run, resolved.definition)) return

  throw new MaterializationConflictError(
    "run-correlation",
    `Projection run '${run.id}' target object types do not match projection '${resolved.projectionId}'.`
  )
}

function projectionRunTargetsMatch(
  run: ProjectionMaterializationRunRecord,
  definition: ProjectionDefinition
): boolean {
  switch (definition._tag) {
    case "ObjectProjectionDefinition":
    case "TelemetryProjectionDefinition":
      return matchesSingleObjectTarget(run, definition.objectTypeId)
    case "LinkProjectionDefinition":
      return matchesLinkTargets(run, definition.sourceObjectTypeId, definition.targetObjectTypeId)
  }
}

function matchesSingleObjectTarget(
  run: ProjectionMaterializationRunRecord,
  objectTypeId: string
): boolean {
  return (
    run.objectTypeId === objectTypeId &&
    run.sourceObjectTypeId === undefined &&
    run.targetObjectTypeId === undefined
  )
}

function matchesLinkTargets(
  run: ProjectionMaterializationRunRecord,
  sourceObjectTypeId: string,
  targetObjectTypeId: string
): boolean {
  return (
    run.objectTypeId === undefined &&
    run.sourceObjectTypeId === sourceObjectTypeId &&
    run.targetObjectTypeId === targetObjectTypeId
  )
}
