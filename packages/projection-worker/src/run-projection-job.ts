import type { DatasetDefinition, ProjectionDefinition } from "@sixb/core"
import { projectionKindOf, projectionObjectTypeIds } from "@sixb/core"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ProjectionRunCounters, ProjectionRunRecord } from "@sixb/core/storage"
import { PROJECTION_COUNTER_KEYS } from "@sixb/core/storage"
import { ProjectionWorkerError } from "./errors"
import { runLinkProjection } from "./run-link-projection"
import { runObjectProjection } from "./run-object-projection"
import { runTelemetryProjection } from "./run-telemetry-projection"
import {
  assertDatasetVersionMatchesDefinition,
  assertProjectionCompatibleWithDataset,
} from "./schema-validation"
import type {
  ProjectionExecutionResult,
  ProjectionJob,
  ProjectionJobResult,
  RunProjectionJobInput,
} from "./types"
import {
  createAbortError,
  createZeroCounters,
  errorMessage,
  snapshotCounters,
  throwIfAborted,
} from "./utils"

const DEFAULT_BATCH_SIZE = 500

export async function runProjectionJob(input: RunProjectionJobInput): Promise<ProjectionJobResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const projectId = runtime.projectId
  const counters = createZeroCounters()
  let started = false
  let finished = false
  let runFinishAttempted = false
  let materialized = false

  try {
    // Resolve up front so the run records the object type(s) it targets (used
    // for authorization). Resolution still happens before validation, so an
    // unknown projection is recorded as a started run and then fails below.
    const resolvedProjection = runtime.getProjectionById(job.projectionId)

    await runtime.projectionRunsStorage.start({
      projectId,
      id: job.id,
      projectionId: job.projectionId,
      projectionKind: job.projectionKind,
      datasetId: job.datasetId,
      datasetVersionId: job.versionId,
      ...(resolvedProjection ? projectionObjectTypeIds(resolvedProjection) : {}),
    })
    started = true

    throwIfAborted(signal)

    const projection = requireProjection(resolvedProjection, job)
    const dataset = requireRegisteredDataset(runtime.getDatasetById(job.datasetId), job)
    await assertLakeDatasetExists(runtime.lakeStorage, job)
    const version = await requireDatasetVersion(runtime.lakeStorage, job)

    assertDatasetVersionMatchesDefinition({ dataset, version })
    assertProjectionCompatibleWithDataset({ projection, dataset, ontology: runtime.ontology })

    // V1 materialization is batch-scoped, not globally transactional across object storage writes.
    // A failed or cancelled run can leave flushed batches visible; retries must stay idempotent.
    const execution = await executeProjection({
      runtime,
      job,
      projection,
      dataset,
      signal,
      batchSize,
      onProgress: async (nextCounters) => {
        Object.assign(counters, nextCounters)
        materialized = hasMaterialized(nextCounters)
        await runtime.projectionRunsStorage.update({
          projectId,
          id: job.id,
          ...nextCounters,
        })
      },
    })

    for (const key of PROJECTION_COUNTER_KEYS) {
      counters[key] = execution[key]
    }
    materialized = hasMaterialized(counters)

    if (execution.firstErrorMessage) {
      runFinishAttempted = true
      const run = await finishRun({
        runtime,
        job,
        status: "failed",
        counters,
        errorMessage: execution.firstErrorMessage,
        materialized,
      })
      finished = true
      throw new ProjectionWorkerError(
        `[SixbProjectionWorker] Projection run '${run.id}' failed. ${execution.firstErrorMessage}`
      )
    }

    runFinishAttempted = true
    const run = await finishRun({
      runtime,
      job,
      status: "succeeded",
      counters,
      materialized,
    })
    finished = true

    return {
      id: job.id,
      projectionId: job.projectionId,
      projectionKind: job.projectionKind,
      datasetId: job.datasetId,
      datasetVersionId: job.versionId,
      ...snapshotCounters(counters),
      run,
    }
  } catch (error) {
    if (started && !finished && !runFinishAttempted) {
      await finishAfterError({
        runtime,
        job,
        counters,
        error,
        materialized,
        signal,
      })
    }

    throw error
  }
}

async function executeProjection(input: {
  readonly runtime: RunProjectionJobInput["runtime"]
  readonly job: ProjectionJob
  readonly projection: ProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly signal: AbortSignal
  readonly batchSize: number
  readonly onProgress: (counters: ProjectionRunCounters) => Promise<void>
}): Promise<ProjectionExecutionResult> {
  const { runtime, job, projection, dataset, signal, batchSize, onProgress } = input
  if (projection._tag === "ObjectProjectionDefinition") {
    return runObjectProjection({
      runtime,
      projection,
      dataset,
      versionId: job.versionId,
      signal,
      batchSize,
      onProgress,
    })
  }

  if (projection._tag === "LinkProjectionDefinition") {
    return runLinkProjection({
      runtime,
      projection,
      dataset,
      versionId: job.versionId,
      signal,
      batchSize,
      onProgress,
    })
  }

  if (projection._tag === "TelemetryProjectionDefinition") {
    return runTelemetryProjection({
      runtime,
      projection,
      dataset,
      versionId: job.versionId,
      signal,
      batchSize,
      onProgress,
    })
  }

  throw new ProjectionWorkerError(
    `[SixbProjectionWorker] Unsupported projection kind '${(projection as { _tag: string })._tag}'.`
  )
}

function requireProjection(
  projection: ProjectionDefinition | null,
  job: ProjectionJob
): ProjectionDefinition {
  if (!projection) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Unknown projection '${job.projectionId}'.`
    )
  }

  const actualKind = projectionKindOf(projection)
  if (actualKind !== job.projectionKind) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Projection '${job.projectionId}' has kind '${actualKind}', job requested '${job.projectionKind}'.`
    )
  }

  if (projection.datasetId !== job.datasetId) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Projection '${job.projectionId}' targets dataset '${projection.datasetId}', job requested '${job.datasetId}'.`
    )
  }

  return projection
}

function requireRegisteredDataset(
  dataset: DatasetDefinition | null,
  job: ProjectionJob
): DatasetDefinition {
  if (!dataset) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Projection job '${job.id}' references unknown dataset '${job.datasetId}'.`
    )
  }
  return dataset
}

async function assertLakeDatasetExists(
  lakeStorage: RunProjectionJobInput["runtime"]["lakeStorage"],
  job: ProjectionJob
): Promise<void> {
  const lakeDataset = await lakeStorage.getDataset(job.datasetId)
  if (!lakeDataset) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Dataset '${job.datasetId}' is not registered in lake storage.`
    )
  }
}

async function requireDatasetVersion(
  lakeStorage: RunProjectionJobInput["runtime"]["lakeStorage"],
  job: ProjectionJob
): Promise<DatasetVersion> {
  const version = await lakeStorage.getVersion(job.datasetId, job.versionId)
  if (!version) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Dataset '${job.datasetId}' version '${job.versionId}' was not found.`
    )
  }
  return version
}

async function finishRun(input: {
  readonly runtime: RunProjectionJobInput["runtime"]
  readonly job: ProjectionJob
  readonly status: "succeeded" | "failed" | "cancelled"
  readonly counters: ProjectionRunCounters
  readonly materialized: boolean
  readonly errorMessage?: string
}): Promise<ProjectionRunRecord> {
  try {
    return await input.runtime.projectionRunsStorage.finish({
      projectId: input.runtime.projectId,
      id: input.job.id,
      status: input.status,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      ...input.counters,
    })
  } catch (error) {
    if (input.materialized) {
      throw createBookkeepingError({
        projectionId: input.job.projectionId,
        runId: input.job.id,
        datasetVersionId: input.job.versionId,
        cause: error,
      })
    }
    throw error
  }
}

async function finishAfterError(input: {
  readonly runtime: RunProjectionJobInput["runtime"]
  readonly job: ProjectionJob
  readonly counters: ProjectionRunCounters
  readonly error: unknown
  readonly materialized: boolean
  readonly signal: AbortSignal
}): Promise<void> {
  const status = input.signal.aborted || isAbortError(input.error) ? "cancelled" : "failed"
  const error = status === "cancelled" ? createAbortError() : input.error

  try {
    await input.runtime.projectionRunsStorage.finish({
      projectId: input.runtime.projectId,
      id: input.job.id,
      status,
      errorMessage: errorMessage(error),
      ...input.counters,
    })
  } catch (finishError) {
    if (input.materialized) {
      throw createBookkeepingError({
        projectionId: input.job.projectionId,
        runId: input.job.id,
        datasetVersionId: input.job.versionId,
        cause: finishError,
      })
    }
  }
}

function hasMaterialized(counters: ProjectionRunCounters): boolean {
  return (
    counters.objectsUpserted > 0 ||
    counters.linksUpserted > 0 ||
    counters.telemetryPointsAppended > 0
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function createBookkeepingError(input: {
  readonly projectionId: string
  readonly runId: string
  readonly datasetVersionId: string
  readonly cause: unknown
}): Error {
  return new ProjectionWorkerError(
    `[SixbProjectionWorker] Projection '${input.projectionId}' materialized dataset version '${input.datasetVersionId}', but failed to finalize projection run '${input.runId}'. The materialized projection state may need repair.`,
    { cause: input.cause }
  )
}
