import { sha256Canonical } from "../materialization/identity"
import type { ProjectionMaterializationIdentity } from "../materialization/model"

export function createProjectionRunId(
  projectId: string,
  identity: ProjectionMaterializationIdentity
): string {
  return sha256Canonical({
    projectId,
    projectionId: identity.projectionId,
    projectionKind: identity.projectionKind,
    protocol: identity.protocol,
    datasetId: identity.datasetVersion.datasetId,
    versionId: identity.datasetVersion.versionId,
    createdAt: identity.datasetVersion.createdAt,
    ontologyRevision: identity.ontologyRevision,
    projectionRevision: identity.projectionRevision,
    ownershipHash: identity.ownershipHash,
  })
}
