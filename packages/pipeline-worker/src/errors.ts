import type { DatasetDefinition, PipelineDefinition } from "@sixb/core"
import { createSixbError, isSixbError, summarizeErrorMessage } from "@sixb/core/internal/errors"
import type { DatasetVersion, DatasetVersionRef } from "@sixb/core/lake-storage"
import type { PipelineRunStatus } from "@sixb/core/storage"
import type { PipelineJob } from "./types"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError()
  }
}

/**
 * How a step or run ends. A step that throws an abort by itself cancelled its own work. Nothing
 * asks this of a worker being stopped, whose signal says only that the delivery ended: the run
 * stays running, and the next delivery takes it up.
 */
export function statusForFailure(
  error: unknown
): Extract<PipelineRunStatus, "failed" | "cancelled"> {
  return isAbortError(error) ? "cancelled" : "failed"
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

/**
 * A dataset version is durable but its record is not. The run stays running: the next delivery
 * finds the version by its producer and records it, so nothing is written twice.
 */
export class CommitNotRecordedError extends Error {
  override readonly name = "CommitNotRecordedError"
}

export function createStepBookkeepingError(options: {
  readonly pipelineId: string
  readonly pipelineRunId: string
  readonly stepId: string
  readonly stepRunId: string
  readonly version: DatasetVersion
  readonly cause: unknown
}): Error {
  return new CommitNotRecordedError(
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' step '${options.stepId}' committed dataset version '${options.version.versionId}', but failed to finalize step run '${options.stepRunId}'.`,
    { cause: options.cause }
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
  readonly version: DatasetVersionRef
  readonly cause: unknown
}): Error {
  return new CommitNotRecordedError(
    `[SixbPipelineWorker] Pipeline '${options.pipelineId}' committed final dataset version '${options.version.versionId}', but failed to finalize pipeline run '${options.runId}'.`,
    { cause: options.cause }
  )
}

export function requirePipeline(
  pipeline: PipelineDefinition | null,
  job: Pick<PipelineJob, "id" | "pipelineId">
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
