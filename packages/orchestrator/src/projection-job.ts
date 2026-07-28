import type { ProjectionMaterializationIdentity } from "@sixb/core/internal/materialization"
import {
  createProjectionRunId,
  type ProjectionDispatchDescriptor,
} from "@sixb/core/internal/projections"
import type { NewQueueJob, ProjectionRunRequestedQueueJob } from "@sixb/core/queues"

type PinnedProjectionDatasetVersion = ProjectionMaterializationIdentity["datasetVersion"]
type BuiltProjectionJob = NewQueueJob<ProjectionRunRequestedQueueJob> & { readonly id: string }

export function buildProjectionJob(input: {
  readonly projectId: string
  readonly descriptor: ProjectionDispatchDescriptor
  readonly datasetVersion: PinnedProjectionDatasetVersion
  readonly metadata?: Readonly<Record<string, string>>
}): BuiltProjectionJob {
  const payload = projectionMaterializationIdentity(input.descriptor, input.datasetVersion)
  return {
    id: createProjectionRunId(input.projectId, payload),
    type: "projection.run.requested",
    payload,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}

function projectionMaterializationIdentity(
  descriptor: ProjectionDispatchDescriptor,
  datasetVersion: PinnedProjectionDatasetVersion
): ProjectionMaterializationIdentity {
  const { datasetId: _datasetId, ...semanticIdentity } = descriptor
  return { ...semanticIdentity, datasetVersion }
}
