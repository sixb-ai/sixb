import { SixbError } from "../../errors"
import type {
  PinnedDatasetVersion,
  ProjectionMaterializationIdentity,
} from "../../materialization/model"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ResolvedProjection,
  TelemetryProjectionDefinition,
} from "../../projections/types"

type SourceProjectionDefinition = ObjectProjectionDefinition | LinkProjectionDefinition
type SourceMaterializationIdentity = Extract<
  ProjectionMaterializationIdentity,
  { readonly protocol: "replacement" }
>
type TelemetryMaterializationIdentity = Extract<
  ProjectionMaterializationIdentity,
  { readonly protocol: "telemetry" }
>

interface ProjectionRunIdentityInput<
  TDefinition extends SourceProjectionDefinition | TelemetryProjectionDefinition,
> {
  readonly resolved: ResolvedProjection<TDefinition>
  readonly datasetVersion: PinnedDatasetVersion
  readonly ontologyRevision: string
}

export function createProjectionRunMaterializationIdentity(
  input: ProjectionRunIdentityInput<SourceProjectionDefinition>
): SourceMaterializationIdentity
export function createProjectionRunMaterializationIdentity(
  input: ProjectionRunIdentityInput<TelemetryProjectionDefinition>
): TelemetryMaterializationIdentity
export function createProjectionRunMaterializationIdentity(
  input: ProjectionRunIdentityInput<SourceProjectionDefinition | TelemetryProjectionDefinition>
): ProjectionMaterializationIdentity
export function createProjectionRunMaterializationIdentity(
  input: ProjectionRunIdentityInput<SourceProjectionDefinition | TelemetryProjectionDefinition>
): ProjectionMaterializationIdentity {
  const base = {
    projectionId: input.resolved.projectionId,
    datasetVersion: input.datasetVersion,
    ontologyRevision: input.ontologyRevision,
    projectionRevision: input.resolved.projectionRevision,
    ownershipHash: input.resolved.ownershipHash,
  }

  switch (input.resolved.definition._tag) {
    case "ObjectProjectionDefinition":
      return { ...base, projectionKind: "object", protocol: "replacement" }
    case "LinkProjectionDefinition":
      return { ...base, projectionKind: "link", protocol: "replacement" }
    case "TelemetryProjectionDefinition":
      return { ...base, projectionKind: "telemetry", protocol: "telemetry" }
    default:
      throw new SixbError(
        "ontology.invalid_value",
        "[Sixb] Expected a supported projection definition."
      )
  }
}
