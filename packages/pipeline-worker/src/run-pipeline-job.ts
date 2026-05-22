import type { DatasetVersion, PipelineRunRecord } from "@pario/core"
import {
  createPipelineBookkeepingError,
  requireFinishedAt,
  requirePipeline,
  statusForFailure,
  throwIfAborted,
  toPipelineRunFailure,
} from "./errors"
import { runStep } from "./run-step"
import type { PipelineRunResult, PipelineStepRunResult, RunPipelineJobInput } from "./types"

export async function runPipelineJob(input: RunPipelineJobInput): Promise<PipelineRunResult> {
  const { runtime, job } = input
  const signal = input.signal ?? new AbortController().signal
  const pipeline = requirePipeline(runtime.getPipelineById(job.pipelineId), job)
  const steps: PipelineStepRunResult[] = []
  let startedRun: PipelineRunRecord | undefined
  let finalVersion: DatasetVersion | undefined
  let finished = false

  throwIfAborted(signal)

  try {
    startedRun = await runtime.pipelineRunsStorage.start({
      projectId: runtime.id,
      id: job.id,
      pipelineId: pipeline.id,
    })
    await input.onRunStarted?.(startedRun)

    for (const [stepIndex, node] of pipeline.graph.nodes.entries()) {
      const stepResult = await runStep({
        runtime,
        pipeline,
        step: node.step,
        stepIndex,
        job,
        signal,
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
      await runtime.pipelineRunsStorage
        .finish({
          projectId: runtime.id,
          id: job.id,
          status: statusForFailure(signal, error),
          error: toPipelineRunFailure(error),
        })
        .catch(() => {})
    }

    throw error
  }
}
