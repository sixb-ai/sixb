import type {
  DatasetDefinition,
  DatasetVersion,
  PipelineDefinition,
  PipelineStepDefinition,
  PipelineStepRunRecord,
} from "@sixb/core"
import {
  createStepBookkeepingError,
  requireRegisteredDataset,
  statusForFailure,
  throwIfAborted,
  toPipelineRunFailure,
} from "./errors"
import { executeRunStep } from "./execute-run-step"
import { executeSqlStep } from "./execute-sql-step"
import { type ResolvedStepInput, resolveStepInputs } from "./step-inputs"
import type {
  PipelineJob,
  PipelineLogSession,
  PipelineStepFinishedHandler,
  PipelineStepRunResult,
  PipelineStepStartedHandler,
  PipelineWorkerContext,
} from "./types"

type StepExecutionResult = {
  readonly version: DatasetVersion
  readonly rowsWritten?: number
}

export async function runStep(input: {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly stepIndex: number
  readonly job: PipelineJob
  readonly signal: AbortSignal
  readonly logSession: PipelineLogSession
  readonly onStepStarted?: PipelineStepStartedHandler
  readonly onStepFinished?: PipelineStepFinishedHandler
}): Promise<PipelineStepRunResult> {
  const { runtime, pipeline, step, stepIndex, job, signal } = input
  const lifecycleContext = {
    stepIndex,
    totalSteps: pipeline.graph.nodes.length,
  }

  throwIfAborted(signal)
  const resolvedInputs = await resolveStepInputs({ runtime, pipeline, step })
  const inputRefs = resolvedInputs.map((resolved) => resolved.ref)
  const outputDataset = requireRegisteredDataset({
    dataset: runtime.getDatasetById(step.output.id),
    pipelineId: pipeline.id,
    stepId: step.id,
    role: "output",
    datasetId: step.output.id,
  })

  await runtime.lakeStorage.createDataset(outputDataset)

  const stepRunId = `${job.id}:step:${stepIndex + 1}:${step.id}`
  const startedStepRun = await runtime.pipelineRunsStorage.startStep({
    projectId: runtime.id,
    id: stepRunId,
    pipelineRunId: job.id,
    pipelineId: pipeline.id,
    stepId: step.id,
    datasetId: outputDataset.id,
    mode: step.mode,
    inputs: inputRefs,
  })
  await input.onStepStarted?.(startedStepRun, lifecycleContext)

  let committedVersion: DatasetVersion | undefined
  let rowsWritten: number | undefined

  try {
    const execution = await executeStep({
      runtime,
      pipeline,
      step,
      job,
      signal,
      logSession: input.logSession,
      outputDataset,
      resolvedInputs,
    })
    committedVersion = execution.version
    rowsWritten = execution.rowsWritten

    let stepRun: PipelineStepRunRecord
    try {
      stepRun = await runtime.pipelineRunsStorage.finishStep({
        projectId: runtime.id,
        id: stepRunId,
        status: "succeeded",
        output: {
          datasetId: committedVersion.datasetId,
          versionId: committedVersion.versionId,
        },
        rowsWritten,
      })
    } catch (error) {
      throw createStepBookkeepingError({
        pipelineId: pipeline.id,
        stepId: step.id,
        runId: stepRunId,
        version: committedVersion,
        cause: error,
      })
    }
    await input.onStepFinished?.(stepRun, lifecycleContext)

    return {
      run: stepRun,
      version: committedVersion,
    }
  } catch (error) {
    if (!committedVersion) {
      const failedStepRun = await runtime.pipelineRunsStorage
        .finishStep({
          projectId: runtime.id,
          id: stepRunId,
          status: statusForFailure(signal, error),
          rowsWritten,
          error: toPipelineRunFailure(error),
        })
        .catch(() => null)

      if (failedStepRun) {
        await input.onStepFinished?.(failedStepRun, lifecycleContext)
      }
    }

    throw error
  }
}

async function executeStep(input: {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly job: PipelineJob
  readonly signal: AbortSignal
  readonly logSession: PipelineLogSession
  readonly outputDataset: DatasetDefinition
  readonly resolvedInputs: readonly ResolvedStepInput[]
}): Promise<StepExecutionResult> {
  switch (input.step.executor.kind) {
    case "run":
      return executeRunStep(input)
    case "sql":
      return executeSqlStep(input)
  }
}
