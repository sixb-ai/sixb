import type {
  DatasetDefinition,
  DatasetVersion,
  PipelineDefinition,
  PipelineRunFailure,
  PipelineRunStatus,
} from "@sixb/core"
import type { PipelineJob } from "./types"

export class PipelineWorkerError extends Error {
  readonly name = "PipelineWorkerError"
}

export function toPipelineRunFailure(error: unknown): PipelineRunFailure {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    }
  }

  return {
    message: String(error),
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError()
  }
}

export function statusForFailure(
  signal: AbortSignal,
  error: unknown
): Extract<PipelineRunStatus, "failed" | "cancelled"> {
  return signal.aborted || isAbortError(error) ? "cancelled" : "failed"
}

export function requireFinishedAt(runId: string, finishedAt: Date | undefined): Date {
  if (finishedAt) {
    return finishedAt
  }

  throw new PipelineWorkerError(
    `[SixbPipelineWorker] Pipeline run '${runId}' finished without a finishedAt timestamp.`
  )
}

export function createStepBookkeepingError(options: {
  readonly pipelineId: string
  readonly stepId: string
  readonly runId: string
  readonly version: DatasetVersion
  readonly cause: unknown
}): Error {
  // The dataset version is already durable; retrying the whole pipeline could duplicate appends.
  return new PipelineWorkerError(
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' step '${options.stepId}' committed dataset version '${options.version.versionId}', but failed to finalize step run '${options.runId}'. The dataset commit may already have succeeded and the step run record may need repair.`,
    { cause: options.cause }
  )
}

export function createPipelineBookkeepingError(options: {
  readonly pipelineId: string
  readonly runId: string
  readonly version: DatasetVersion
  readonly cause: unknown
}): Error {
  return new PipelineWorkerError(
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' committed final dataset version '${options.version.versionId}', but failed to finalize pipeline run '${options.runId}'. The dataset commit may already have succeeded and the pipeline run record may need repair.`,
    { cause: options.cause }
  )
}

export function requirePipeline(
  pipeline: PipelineDefinition | null,
  job: PipelineJob
): PipelineDefinition {
  if (!pipeline) {
    throw new PipelineWorkerError(`[SixbPipelineWorker] Unknown pipeline '${job.pipelineId}'.`)
  }

  return pipeline
}

export function requireRegisteredDataset(options: {
  readonly dataset: DatasetDefinition | null
  readonly pipelineId: string
  readonly stepId: string
  readonly role: "input" | "output"
  readonly name?: string
  readonly datasetId: string
}): DatasetDefinition {
  if (options.dataset) {
    return options.dataset
  }

  const namedRole = options.role === "input" ? `input '${options.name ?? "unknown"}'` : "output"

  throw new PipelineWorkerError(
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' step '${options.stepId}' ${namedRole} references unknown dataset '${options.datasetId}'.`
  )
}

function createAbortError(): Error {
  const error = new Error("Worker runtime aborted.")
  error.name = "AbortError"
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
