import type { SixbBranch } from "../branch-mode"
import { sha256Canonical } from "../materialization/identity"
import type { ProjectionMaterializationIdentity } from "../materialization/model"

/**
 * A projection run is named by what it applies, so every process derives the same id. A branch
 * names its own runs: it projects production's dataset versions as of when it was copied, and its
 * runs must never pass for production's. Production's ids are unchanged.
 */
export function createProjectionRunId(
  projectId: string,
  identity: ProjectionMaterializationIdentity,
  branch: SixbBranch | null
): string {
  return sha256Canonical({
    projectId,
    ...(branch ? { branch: branch.name } : {}),
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
