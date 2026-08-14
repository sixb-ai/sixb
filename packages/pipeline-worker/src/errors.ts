import type { DatasetDefinition, PipelineDefinition } from "@sixb/core"
import { createSixbError, isSixbError, summarizeErrorMessage } from "@sixb/core/internal/errors"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { PipelineRunStatus } from "@sixb/core/storage"
import type { PipelineJob } from "./types"

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

export function requireFinishedAt(input: {
  readonly pipelineId: string
  readonly runId: string
  readonly finishedAt: Date | undefined
}): Date {
  if (input.finishedAt) {
    return input.finishedAt
  }

  throw createSixbError(
    "internal.unexpected",
    `[SixbPipelineWorker] Pipeline run '${input.runId}' finished without a finishedAt timestamp.`,
    { details: { pipelineId: input.pipelineId, runId: input.runId } }
  )
}

export function createStepBookkeepingError(options: {
  readonly pipelineId: string
  readonly pipelineRunId: string
  readonly stepId: string
  readonly stepRunId: string
  readonly version: DatasetVersion
  readonly cause: unknown
}): Error {
  // The dataset version is already durable; retrying the whole pipeline could duplicate appends.
  return createSixbError(
    "internal.unexpected",
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' step '${options.stepId}' committed dataset version '${options.version.versionId}', but failed to finalize step run '${options.stepRunId}'. The dataset commit may already have succeeded and the step run record may need repair.`,
    {
      cause: options.cause,
      details: {
        pipelineId: options.pipelineId,
        pipelineRunId: options.pipelineRunId,
        stepId: options.stepId,
        stepRunId: options.stepRunId,
        datasetId: options.version.datasetId,
        versionId: options.version.versionId,
      },
    }
  )
}

export function createPipelineStepFailure(options: {
  readonly pipelineId: string
  readonly pipelineRunId: string
  readonly stepId: string
  readonly stepRunId?: string
  readonly cause: unknown
}) {
  return createSixbError(
    "pipeline.step_failed",
    summarizeErrorMessage(options.cause, "Pipeline step execution failed."),
    {
      cause: options.cause,
      details: {
        pipelineId: options.pipelineId,
        pipelineRunId: options.pipelineRunId,
        stepId: options.stepId,
        ...(options.stepRunId ? { stepRunId: options.stepRunId } : {}),
      },
    }
  )
}

export function unwrapPipelineStepFailure(error: unknown): unknown {
  return isSixbError(error) && error.code === "pipeline.step_failed" && error.cause !== undefined
    ? error.cause
    : error
}

export function createPipelineBookkeepingError(options: {
  readonly pipelineId: string
  readonly runId: string
  readonly version: DatasetVersion
  readonly cause: unknown
}): Error {
  return createSixbError(
    "internal.unexpected",
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' committed final dataset version '${options.version.versionId}', but failed to finalize pipeline run '${options.runId}'. The dataset commit may already have succeeded and the pipeline run record may need repair.`,
    {
      cause: options.cause,
      details: {
        pipelineId: options.pipelineId,
        runId: options.runId,
        datasetId: options.version.datasetId,
        versionId: options.version.versionId,
      },
    }
  )
}

export function requirePipeline(
  pipeline: PipelineDefinition | null,
  job: PipelineJob
): PipelineDefinition {
  if (!pipeline) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbPipelineWorker] Unknown pipeline '${job.pipelineId}'.`,
      { details: { pipelineId: job.pipelineId, runId: job.id } }
    )
  }

  return pipeline
}

export function requireRegisteredDataset(options: {
  readonly dataset: DatasetDefinition | null
  readonly pipelineId: string
  readonly pipelineRunId: string
  readonly stepId: string
  readonly role: "input" | "output"
  readonly name?: string
  readonly datasetId: string
}): DatasetDefinition {
  if (options.dataset) {
    return options.dataset
  }

  const namedRole = options.role === "input" ? `input '${options.name ?? "unknown"}'` : "output"

  throw createSixbError(
    "internal.unexpected",
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' step '${options.stepId}' ${namedRole} references unknown dataset '${options.datasetId}'.`,
    {
      details: {
        pipelineId: options.pipelineId,
        pipelineRunId: options.pipelineRunId,
        stepId: options.stepId,
        datasetId: options.datasetId,
      },
    }
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
