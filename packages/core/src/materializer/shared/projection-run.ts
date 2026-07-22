import { MaterializationValidationError } from "../../materialization/errors"
import type { PinnedDatasetVersion } from "../../materialization/model"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import type { ProjectionRunMaterializationIdentity } from "../../storage"

export function createProjectionRunMaterializationIdentity(input: {
  readonly protocol: "replacement" | "telemetry"
  readonly resolved: ResolvedProjection<ProjectionDefinition>
  readonly datasetVersion: PinnedDatasetVersion
  readonly ontologyRevision: string
}): ProjectionRunMaterializationIdentity {
  const base = {
    projectionId: input.resolved.projectionId,
    datasetVersion: input.datasetVersion,
    ontologyRevision: input.ontologyRevision,
    projectionRevision: input.resolved.projectionRevision,
    ownershipHash: input.resolved.ownershipHash,
  }

  if (input.protocol === "telemetry") {
    if (input.resolved.definition._tag !== "TelemetryProjectionDefinition") {
      throw new MaterializationValidationError(
        "Telemetry materialization requires a telemetry projection."
      )
    }
    return { ...base, projectionKind: "telemetry", protocol: "telemetry" }
  }

  switch (input.resolved.definition._tag) {
    case "ObjectProjectionDefinition":
      return { ...base, projectionKind: "object", protocol: "replacement" }
    case "LinkProjectionDefinition":
      return { ...base, projectionKind: "link", protocol: "replacement" }
    case "TelemetryProjectionDefinition":
      throw new MaterializationValidationError(
        "Replacement completion requires a source projection."
      )
  }
}
