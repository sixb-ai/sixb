import type {
  DatasetDefinition,
  LinkProjectionDefinition,
  LinkProjectionTarget,
  ObjectProjectionDefinition,
  ObjectProjectionTarget,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "@sixb/core"
import { createSixbError, isSixbError } from "@sixb/core/internal/errors"
import {
  createProjectionRunId,
  getProjectionRegistry,
  type ProjectionDispatchDescriptor,
  projectionTargetOf,
} from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { collectIdentityMismatches } from "./identity-mismatch"
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
  const descriptor = resolveDescriptor(registry, job)
  assertDescriptorMatchesJob(descriptor, job)

  const projection = requireProjection(runtime, job)
  const dataset = requireDataset(runtime, job)
  const version = await requirePinnedVersion(runtime, job)

  validatePinnedSchema({ runtime, job, projection, dataset, version })

  return correlateValidatedProjection({ job, projection, dataset, version })
}

function correlateValidatedProjection(
  input: ValidatedProjectionDependencies
): ValidatedProjectionJob {
  switch (input.projection._tag) {
    case "ObjectProjectionDefinition":
      if (input.job.projectionKind !== "object") {
        throw invalidProjectionKind(input.job, "object")
      }
      return {
        ...input,
        kind: "object",
        job: input.job,
        projection: input.projection,
        target: projectionTargetOf(input.projection),
      }
    case "LinkProjectionDefinition":
      if (input.job.projectionKind !== "link") {
        throw invalidProjectionKind(input.job, "link")
      }
      return {
        ...input,
        kind: "link",
        job: input.job,
        projection: input.projection,
        target: projectionTargetOf(input.projection),
      }
    case "TelemetryProjectionDefinition":
      if (input.job.projectionKind !== "telemetry") {
        throw invalidProjectionKind(input.job, "telemetry")
      }
      return {
        ...input,
        kind: "telemetry",
        job: input.job,
        projection: input.projection,
        target: projectionTargetOf(input.projection),
      }
  }
}

function invalidProjectionKind(
  job: ProjectionJob,
  expectedProjectionKind: ProjectionJob["projectionKind"]
) {
  return createSixbError(
    "projection.run_identity_mismatch",
    `[SixbProjectionWorker] Projection '${job.projectionId}' does not match queued kind '${job.projectionKind}'.`,
    {
      details: {
        ...projectionRunContext(job),
        identityMismatches: collectIdentityMismatches([
          {
            field: "projectionKind",
            expected: expectedProjectionKind,
            actual: job.projectionKind,
          },
        ]),
      },
    }
  )
}

function validatePinnedSchema(input: {
  readonly runtime: ProjectionWorkerContext
  readonly job: ProjectionJob
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
}): void {
  try {
    const runId = input.job.id
    const validationInput = {
      projection: input.projection,
      dataset: input.dataset,
      version: input.version,
      runId,
    }
    assertDatasetVersionMatchesDefinition(validationInput)
    assertProjectionCompatibleWithDataset({
      ...validationInput,
      ontology: input.runtime.ontology,
    })
  } catch (error) {
    if (
      isSixbError(error) &&
      (error.code === "dataset.version_incompatible" ||
        error.code === "projection.definition_invalid")
    ) {
      throw error
    }
    throw createSixbError(
      "projection.definition_invalid",
      `[SixbProjectionWorker] Projection '${input.projection.id}' is incompatible with its pinned dataset version: ${errorMessage(error)}`,
      {
        cause: error,
        details: projectionJobContext(input.job),
      }
    )
  }
}

export function assertProjectionJobId(projectId: string, job: ProjectionJob): void {
  const expected = createProjectionRunId(projectId, job)
  if (job.id === expected) return
  throw createSixbError(
    "projection.run_identity_mismatch",
    `[SixbProjectionWorker] Projection job id '${job.id}' does not match its pinned semantic identity.`,
    {
      details: {
        ...projectionRunContext(job),
        identityMismatches: collectIdentityMismatches([
          { field: "runId", expected, actual: job.id },
        ]),
      },
    }
  )
}

function resolveDescriptor(
  registry: ReturnType<typeof getProjectionRegistry>,
  job: ProjectionJob
): ProjectionDispatchDescriptor {
  try {
    return registry.resolveDispatch(job.projectionId)
  } catch (error) {
    throw createSixbError(
      "projection.not_found",
      `[SixbProjectionWorker] Projection '${job.projectionId}' is not registered.`,
      { cause: error, details: projectionJobContext(job) }
    )
  }
}

function assertDescriptorMatchesJob(
  descriptor: ProjectionDispatchDescriptor,
  job: ProjectionJob
): void {
  const identityMismatches = collectIdentityMismatches([
    {
      field: "projectionId",
      expected: job.projectionId,
      actual: descriptor.projectionId,
    },
    {
      field: "projectionKind",
      expected: job.projectionKind,
      actual: descriptor.projectionKind,
    },
    { field: "protocol", expected: job.protocol, actual: descriptor.protocol },
    {
      field: "datasetId",
      expected: job.datasetVersion.datasetId,
      actual: descriptor.datasetId,
    },
    {
      field: "ontologyRevision",
      expected: job.ontologyRevision,
      actual: descriptor.ontologyRevision,
    },
    {
      field: "projectionRevision",
      expected: job.projectionRevision,
      actual: descriptor.projectionRevision,
    },
    {
      field: "ownershipHash",
      expected: job.ownershipHash,
      actual: descriptor.ownershipHash,
    },
  ])
  if (identityMismatches.length === 0) return
  throw createSixbError(
    "projection.run_identity_mismatch",
    `[SixbProjectionWorker] Projection '${job.projectionId}' no longer matches the queued semantic identity.`,
    {
      details: {
        ...projectionRunContext(job),
        identityMismatches,
      },
    }
  )
}

function requireProjection(runtime: ProjectionWorkerContext, job: ProjectionJob) {
  const projection = runtime.projections.getById(job.projectionId)
  if (projection) return projection
  throw createSixbError(
    "projection.not_found",
    `[SixbProjectionWorker] Projection '${job.projectionId}' is not registered.`,
    { details: projectionJobContext(job) }
  )
}

function requireDataset(runtime: ProjectionWorkerContext, job: ProjectionJob) {
  const datasetId = job.datasetVersion.datasetId
  const dataset = runtime.datasets.getById(datasetId)
  if (dataset) return dataset
  throw createSixbError(
    "dataset.not_found",
    `[SixbProjectionWorker] Projection references unknown dataset '${datasetId}'.`,
    { details: { ...projectionJobContext(job), source: "runtime" } }
  )
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
    throw createSixbError(
      "dataset.not_found",
      `[SixbProjectionWorker] Dataset '${datasetId}' is not registered in lake storage.`,
      { details: { ...projectionJobContext(job), source: "lake-storage" } }
    )
  }
  if (!version) {
    throw createSixbError(
      "dataset.version_not_found",
      `[SixbProjectionWorker] Dataset '${datasetId}' version '${versionId}' was not found.`,
      { details: projectionJobContext(job) }
    )
  }
  const identityMismatches = collectIdentityMismatches([
    { field: "datasetId", expected: datasetId, actual: version.datasetId },
    {
      field: "versionCreatedAt",
      expected: createdAt,
      actual: version.createdAt.toISOString(),
    },
  ])
  if (identityMismatches.length > 0) {
    throw createSixbError(
      "projection.run_identity_mismatch",
      `[SixbProjectionWorker] Dataset '${datasetId}' version '${versionId}' does not match its queued immutable metadata.`,
      {
        details: {
          ...projectionRunContext(job),
          identityMismatches,
        },
      }
    )
  }
  return version
}

function projectionJobContext(job: ProjectionJob) {
  return {
    projectionId: job.projectionId,
    runId: job.id,
    datasetId: job.datasetVersion.datasetId,
    versionId: job.datasetVersion.versionId,
  }
}

function projectionRunContext(job: ProjectionJob) {
  return {
    projectionId: job.projectionId,
    runId: job.id,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
