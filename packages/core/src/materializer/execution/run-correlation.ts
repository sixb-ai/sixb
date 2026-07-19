import { MaterializationConflictError } from "../../materialization/errors"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import type { ProjectionMaterializationRunRecord } from "../../storage"

export function assertProjectionRunTargets(
  run: ProjectionMaterializationRunRecord,
  resolved: ResolvedProjection<ProjectionDefinition>
): void {
  const definition = resolved.definition
  const matches =
    definition._tag === "LinkProjectionDefinition"
      ? run.objectTypeId === undefined &&
        run.sourceObjectTypeId === definition.sourceObjectTypeId &&
        run.targetObjectTypeId === definition.targetObjectTypeId
      : run.objectTypeId === definition.objectTypeId &&
        run.sourceObjectTypeId === undefined &&
        run.targetObjectTypeId === undefined

  if (!matches) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection run '${run.id}' target object types do not match projection '${resolved.projectionId}'.`
    )
  }
}
