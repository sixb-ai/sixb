import type {
  DatasetDefinition,
  LinkProjectionDefinition,
  LinkProjectionTarget,
  ObjectProjectionDefinition,
  ObjectProjectionTarget,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "@sixb/core"
import type { SixbError } from "@sixb/core/errors"
import {
  createProjectionRunId,
  getProjectionRegistry,
  type ProjectionDispatchDescriptor,
  projectionTargetOf,
} from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { isPermanentProjectionWorkerError, projectionJobStale } from "./errors"
import {
  assertDatasetVersionMatchesDefinition,
  assertProjectionCompatibleWithDataset,
} from "./schema-validation"
import type { ProjectionJob, ProjectionWorkerContext } from "./types"

interface ValidatedProjectionJobBase {
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
}

type ProjectionJobFor<TKind extends ProjectionJob["projectionKind"]> = Extract<
  ProjectionJob,
  { readonly projectionKind: TKind }
>

export type ValidatedProjectionJob = ValidatedProjectionJobBase &
  (
    | {
        readonly kind: "object"
        readonly job: ProjectionJobFor<"object">
        readonly projection: ObjectProjectionDefinition
        readonly target: ObjectProjectionTarget
      }
    | {
        readonly kind: "link"
        readonly job: ProjectionJobFor<"link">
        readonly projection: LinkProjectionDefinition
        readonly target: LinkProjectionTarget
      }
    | {
        readonly kind: "telemetry"
        readonly job: ProjectionJobFor<"telemetry">
        readonly projection: TelemetryProjectionDefinition
        readonly target: ObjectProjectionTarget
      }
  )

interface ValidatedProjectionDependencies {
  readonly job: ProjectionJob
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
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

  return correlateValidatedProjection({ job, projection, dataset, version })
}

function correlateValidatedProjection(
  input: ValidatedProjectionDependencies
): ValidatedProjectionJob {
  switch (input.projection._tag) {
    case "ObjectProjectionDefinition":
      if (input.job.projectionKind !== "object") throw invalidProjectionKind(input.job)
      return {
        ...input,
        kind: "object",
        job: input.job,
        projection: input.projection,
        target: projectionTargetOf(input.projection),
      }
    case "LinkProjectionDefinition":
      if (input.job.projectionKind !== "link") throw invalidProjectionKind(input.job)
      return {
        ...input,
        kind: "link",
        job: input.job,
        projection: input.projection,
        target: projectionTargetOf(input.projection),
      }
    case "TelemetryProjectionDefinition":
      if (input.job.projectionKind !== "telemetry") throw invalidProjectionKind(input.job)
      return {
        ...input,
        kind: "telemetry",
        job: input.job,
        projection: input.projection,
        target: projectionTargetOf(input.projection),
      }
  }
}

function invalidProjectionKind(job: ProjectionJob): SixbError {
  return stale(
    `Projection '${job.projectionId}' does not match queued kind '${job.projectionKind}'.`
  )
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
    if (isPermanentProjectionWorkerError(error)) throw error
    throw stale(
      `Projection '${input.projection.id}' is incompatible with its pinned dataset version: ${errorMessage(error)}`,
      error
    )
  }
}

export function assertProjectionJobId(projectId: string, job: ProjectionJob): void {
  const expected = createProjectionRunId(projectId, job)
  if (job.id === expected) return
  throw stale(`Projection job id '${job.id}' does not match its pinned semantic identity.`)
}

function resolveDescriptor(
  registry: ReturnType<typeof getProjectionRegistry>,
  projectionId: string
): ProjectionDispatchDescriptor {
  try {
    return registry.resolveDispatch(projectionId)
  } catch (error) {
    throw stale(`Projection '${projectionId}' is not registered.`, error)
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
  throw stale(`Projection '${job.projectionId}' no longer matches the queued semantic identity.`)
}

function requireProjection(runtime: ProjectionWorkerContext, projectionId: string) {
  const projection = runtime.getProjectionById(projectionId)
  if (projection) return projection
  throw stale(`Projection '${projectionId}' is not registered.`)
}

function requireDataset(runtime: ProjectionWorkerContext, datasetId: string) {
  const dataset = runtime.getDatasetById(datasetId)
  if (dataset) return dataset
  throw stale(`Projection references unknown dataset '${datasetId}'.`)
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
    throw stale(`Dataset '${datasetId}' is not registered in lake storage.`)
  }
  if (!version) {
    throw stale(`Dataset '${datasetId}' version '${versionId}' was not found.`)
  }
  if (version.datasetId !== datasetId || version.createdAt.toISOString() !== createdAt) {
    throw stale(
      `Dataset '${datasetId}' version '${versionId}' does not match its queued immutable metadata.`
    )
  }
  return version
}

function stale(message: string, cause?: unknown): SixbError {
  return projectionJobStale(`[SixbProjectionWorker] ${message}`, { cause })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
