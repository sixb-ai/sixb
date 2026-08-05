import { captureSixbFailure } from "@sixb/core/internal/errors"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { PIPELINE_RUN_FAILURE_CODES, type PipelineRunRecord } from "@sixb/core/storage"
import {
  createPipelineBookkeepingError,
  requireFinishedAt,
  requirePipeline,
  statusForFailure,
  throwIfAborted,
} from "./errors"
import { runStep } from "./run-step"
import type { PipelineRunResult, PipelineStepRunResult, RunPipelineJobInput } from "./types"

export class PipelineRunAlreadyStartedError extends Error {
  override readonly name = "PipelineRunAlreadyStartedError"

  constructor(readonly run: PipelineRunRecord) {
    super(`[SixbPipelineWorker] Pipeline run '${run.id}' has already started.`)
  }
}

export async function runPipelineJob(input: RunPipelineJobInput): Promise<PipelineRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal
  const pipeline = requirePipeline(runtime.pipelines.getById(job.pipelineId), job)
  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "pipeline",
    id: job.id,
  })
  const steps: PipelineStepRunResult[] = []
  let startedRun: PipelineRunRecord | undefined
  let finalVersion: DatasetVersion | undefined
  let finished = false

  throwIfAborted(signal)

  try {
    try {
      startedRun = await runtime.pipelineRunsStorage.start({
        projectId: runtime.id,
        id: job.id,
        pipelineId: pipeline.id,
      })
    } catch (error) {
      const existing = await runtime.pipelineRunsStorage.getById({
        projectId: runtime.id,
        id: job.id,
      })
      if (existing?.pipelineId === pipeline.id) {
        throw new PipelineRunAlreadyStartedError(existing)
      }
      throw error
    }
    await input.onRunStarted?.(startedRun)

    for (const [stepIndex, node] of pipeline.graph.nodes.entries()) {
      const stepResult = await runStep({
        runtime,
        pipeline,
        step: node.step,
        stepIndex,
        job,
        signal,
        logSession,
        onStepStarted: input.onStepStarted,
        onStepFinished: input.onStepFinished,
      })

      steps.push(stepResult)
      finalVersion = stepResult.version
      // This is the durability boundary for per-step output events.
      await input.onStepCommitted?.(stepResult)
    }

    let run: PipelineRunRecord
    try {
      run = await runtime.pipelineRunsStorage.finish({
        projectId: runtime.id,
        id: job.id,
        status: "succeeded",
        output: finalVersion
          ? {
              datasetId: finalVersion.datasetId,
              versionId: finalVersion.versionId,
            }
          : undefined,
      })
    } catch (error) {
      if (finalVersion) {
        throw createPipelineBookkeepingError({
          pipelineId: pipeline.id,
          runId: job.id,
          version: finalVersion,
          cause: error,
        })
      }
      throw error
    }
    finished = true

    return {
      run: {
        ...run,
        finishedAt: requireFinishedAt(job.id, run.finishedAt),
      },
      steps,
      version: finalVersion,
    }
  } catch (error) {
    if (startedRun && !finished) {
      const status = statusForFailure(signal, error)
      try {
        const run = await runtime.pipelineRunsStorage.finish({
          projectId: runtime.id,
          id: job.id,
          status,
          error: captureSixbFailure(error, {
            allowedCodes: PIPELINE_RUN_FAILURE_CODES,
            defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
            details: { pipelineId: pipeline.id, runId: job.id },
          }),
        })
        if (status === "failed" && run.status === "failed") input.onRunFailed?.(error, run)
      } catch {
        // The run did not transition to the requested terminal status.
      }
    }

    throw error
  } finally {
    await logSession.flush()
  }
}
