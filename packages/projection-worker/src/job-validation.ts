import type { DatasetDefinition, ProjectionDefinition } from "@sixb/core"
import {
  createProjectionRunId,
  getProjectionRegistry,
  type ProjectionDispatchDescriptor,
  projectionObjectTypeIds,
} from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ProjectionRunObjectTypes } from "@sixb/core/storage"
import { ProjectionWorkerPermanentError } from "./errors"
import {
  assertDatasetVersionMatchesDefinition,
  assertProjectionCompatibleWithDataset,
} from "./schema-validation"
import type { ProjectionJob, ProjectionWorkerContext } from "./types"

export interface ValidatedProjectionJob {
  readonly job: ProjectionJob
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readonly objectTypes: ProjectionRunObjectTypes
}

export async function validateProjectionJob(
  runtime: ProjectionWorkerContext,
  job: ProjectionJob
): Promise<ValidatedProjectionJob> {
  const registry = getProjectionRegistry(runtime)
  const descriptor = resolveDescriptor(registry, job.projectionId)
  assertDescriptorMatchesJob(descriptor, job)

  const projection = requireProjection(runtime, job.projectionId)
  const dataset = requireDataset(runtime, job.datasetVersion.datasetId)
  const version = await requirePinnedVersion(runtime, job)

  validatePinnedSchema({ runtime, projection, dataset, version })

  return {
    job,
    projection,
    dataset,
    version,
    objectTypes: projectionObjectTypeIds(projection),
  }
}

function validatePinnedSchema(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
}): void {
  try {
    assertDatasetVersionMatchesDefinition(input)
    assertProjectionCompatibleWithDataset({ ...input, ontology: input.runtime.ontology })
  } catch (error) {
    if (error instanceof ProjectionWorkerPermanentError) throw error
    throw permanent(
      `Projection '${input.projection.id}' is incompatible with its pinned dataset version: ${errorMessage(error)}`,
      error
    )
  }
}

export function assertProjectionJobId(projectId: string, job: ProjectionJob): void {
  const expected = createProjectionRunId(projectId, job)
  if (job.id === expected) return
  throw permanent(`Projection job id '${job.id}' does not match its pinned semantic identity.`)
}

function resolveDescriptor(
  registry: ReturnType<typeof getProjectionRegistry>,
  projectionId: string
): ProjectionDispatchDescriptor {
  try {
    return registry.resolveDispatch(projectionId)
  } catch (error) {
    throw permanent(`Projection '${projectionId}' is not registered.`, error)
  }
}

function assertDescriptorMatchesJob(
  descriptor: ProjectionDispatchDescriptor,
  job: ProjectionJob
): void {
  const matches =
    descriptor.projectionId === job.projectionId &&
    descriptor.projectionKind === job.projectionKind &&
    descriptor.protocol === job.protocol &&
    descriptor.datasetId === job.datasetVersion.datasetId &&
    descriptor.ontologyRevision === job.ontologyRevision &&
    descriptor.projectionRevision === job.projectionRevision &&
    descriptor.ownershipHash === job.ownershipHash

  if (matches) return
  throw permanent(
    `Projection '${job.projectionId}' no longer matches the queued semantic identity.`
  )
}

function requireProjection(runtime: ProjectionWorkerContext, projectionId: string) {
  const projection = runtime.getProjectionById(projectionId)
  if (projection) return projection
  throw permanent(`Projection '${projectionId}' is not registered.`)
}

function requireDataset(runtime: ProjectionWorkerContext, datasetId: string) {
  const dataset = runtime.getDatasetById(datasetId)
  if (dataset) return dataset
  throw permanent(`Projection references unknown dataset '${datasetId}'.`)
}

async function requirePinnedVersion(
  runtime: ProjectionWorkerContext,
  job: ProjectionJob
): Promise<DatasetVersion> {
  const { datasetId, versionId, createdAt } = job.datasetVersion
  const [lakeDataset, version] = await Promise.all([
    runtime.lakeStorage.getDataset(datasetId),
    runtime.lakeStorage.getVersion(datasetId, versionId),
  ])
  if (!lakeDataset) {
    throw permanent(`Dataset '${datasetId}' is not registered in lake storage.`)
  }
  if (!version) {
    throw permanent(`Dataset '${datasetId}' version '${versionId}' was not found.`)
  }
  if (version.datasetId !== datasetId || version.createdAt.toISOString() !== createdAt) {
    throw permanent(
      `Dataset '${datasetId}' version '${versionId}' does not match its queued immutable metadata.`
    )
  }
  return version
}

function permanent(message: string, cause?: unknown): ProjectionWorkerPermanentError {
  return new ProjectionWorkerPermanentError(`[SixbProjectionWorker] ${message}`, { cause })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
