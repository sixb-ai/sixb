import type { DatasetDefinition, PipelineDefinition, PipelineStepDefinition } from "@sixb/core"
import { findProducedVersion, lakeDatasetDefinition } from "@sixb/core/internal/datasets"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { PIPELINE_RUN_FAILURE_CODES, type PipelineStepRunRecord } from "@sixb/core/storage"
import {
  CommitNotRecordedError,
  createPipelineStepFailure,
  createStepBookkeepingError,
  requireRegisteredDataset,
  statusForFailure,
  throwIfAborted,
} from "./errors"
import { executeRunStep } from "./execute-run-step"
import { executeSqlStep } from "./execute-sql-step"
import { type ResolvedStepInput, resolveStepInputs } from "./step-inputs"
import type {
  PipelineJob,
  PipelineLogSession,
  PipelineStepFinishedHandler,
  PipelineStepLifecycleContext,
  PipelineStepRunResult,
  PipelineStepStartedHandler,
  PipelineWorkerContext,
} from "./types"

type StepExecutionResult = {
  readonly version: DatasetVersion
  readonly versionCreated: boolean
  readonly rowsWritten?: number
}

interface RunStepInput {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly stepIndex: number
  readonly job: PipelineJob
  readonly signal: AbortSignal
  readonly logSession: PipelineLogSession
  /** An earlier execution started this step and left no outcome, so it may have committed. */
  readonly recorded?: PipelineStepRunRecord
  /** The run has no attempts left: what landed is recorded, and nothing new starts. */
  readonly givenUp?: Error
  readonly onStepStarted?: PipelineStepStartedHandler
  readonly onStepFinished?: PipelineStepFinishedHandler
}

function pipelineStepRunId(
  job: Pick<PipelineJob, "id">,
  stepIndex: number,
  step: Pick<PipelineStepDefinition, "id">
): string {
  return `${job.id}:step:${stepIndex + 1}:${step.id}`
}

export async function runStep(input: RunStepInput): Promise<PipelineStepRunResult> {
  const { runtime, pipeline, step, stepIndex, job, signal } = input
  const stepRunId = input.recorded?.id ?? pipelineStepRunId(job, stepIndex, step)

  throwIfAborted(signal)
  let resolvedInputs: readonly ResolvedStepInput[]
  let outputDataset: DatasetDefinition
  let expectedLatestVersionId: string | null
  try {
    outputDataset = lakeDatasetDefinition(
      requireRegisteredDataset({
        dataset: runtime.datasets.getById(step.output.id),
        pipelineId: pipeline.id,
        pipelineRunId: job.id,
        stepId: step.id,
        role: "output",
        datasetId: step.output.id,
      })
    )

    await runtime.lakeStorage.createDataset(outputDataset)
    // Capture the output guard before any input is pinned. A later capture could legitimize
    // overwriting a concurrent run with results computed from older inputs.
    expectedLatestVersionId =
      (await runtime.lakeStorage.getLatestVersion(outputDataset.id))?.versionId ?? null

    // Asked after capturing the guard: a commit this misses lands after the guard, which then
    // refuses this step's own. An append written twice is what this order rules out.
    const landed = input.recorded
      ? await findLandedStep(input, outputDataset, input.recorded.startedAt)
      : null
    if (landed) return await recordLandedStep(input, stepRunId, landed)

    if (input.givenUp) throw input.givenUp

    resolvedInputs = await resolveStepInputs({
      runtime,
      pipeline,
      step,
      pipelineRunId: job.id,
    })
  } catch (error) {
    if (error instanceof CommitNotRecordedError) throw error

    if (!signal.aborted && statusForFailure(error) === "failed") {
      throw createPipelineStepFailure({
        pipelineId: pipeline.id,
        pipelineRunId: job.id,
        stepId: step.id,
        cause: error,
      })
    }
    throw error
  }
  const inputRefs = resolvedInputs.map((resolved) => resolved.ref)

  const startedStepRun = await runtime.pipelineRunsStorage.startStep({
    projectId: runtime.id,
    id: stepRunId,
    executionToken: job.executionToken,
    pipelineRunId: job.id,
    pipelineId: pipeline.id,
    stepId: step.id,
    datasetId: outputDataset.id,
    mode: step.mode,
    inputs: inputRefs,
  })
  await input.onStepStarted?.(startedStepRun, stepLifecycle(input))

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
      expectedLatestVersionId,
      resolvedInputs,
    })
    committedVersion = execution.version
    rowsWritten = execution.rowsWritten

    let stepRun: PipelineStepRunRecord
    try {
      stepRun = await runtime.pipelineRunsStorage.finishStep({
        projectId: runtime.id,
        id: stepRunId,
        executionToken: job.executionToken,
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
        pipelineRunId: job.id,
        stepId: step.id,
        stepRunId,
        version: committedVersion,
        cause: error,
      })
    }
    await input.onStepFinished?.(stepRun, stepLifecycle(input))

    return {
      run: stepRun,
      version: committedVersion,
      versionCreated: execution.versionCreated,
    }
  } catch (error) {
    if (committedVersion || signal.aborted) throw error

    // A commit can land and still answer with an error, and a redo can lose its guard to the commit
    // it was redoing: only the lake can say. If it cannot, the run stays open for the next delivery.
    const landed = await findLandedStep(input, outputDataset, startedStepRun.startedAt).catch(
      (cause: unknown) => {
        throw new CommitNotRecordedError(
          `[SixbPipelineWorker] Pipeline '${pipeline.id}' could not tell whether step '${step.id}' committed.`,
          { cause }
        )
      }
    )
    if (landed) return recordLandedStep(input, stepRunId, landed)

    const status = statusForFailure(error)
    const failureError =
      status === "failed"
        ? createPipelineStepFailure({
            pipelineId: pipeline.id,
            pipelineRunId: job.id,
            stepId: step.id,
            stepRunId,
            cause: error,
          })
        : error
    const failedStepRun = await runtime.pipelineRunsStorage
      .finishStep({
        projectId: runtime.id,
        id: stepRunId,
        executionToken: job.executionToken,
        status,
        rowsWritten,
        error: captureSixbFailure(failureError, {
          allowedCodes: PIPELINE_RUN_FAILURE_CODES,
          defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
          details: {
            pipelineId: pipeline.id,
            pipelineRunId: job.id,
            stepId: step.id,
            stepRunId,
          },
        }),
      })
      .catch(() => null)

    if (failedStepRun) {
      await input.onStepFinished?.(failedStepRun, stepLifecycle(input))
    }

    throw failureError
  }
}

function stepLifecycle(input: RunStepInput): PipelineStepLifecycleContext {
  return { stepIndex: input.stepIndex, totalSteps: input.pipeline.graph.nodes.length }
}

/** The version this step committed, whichever execution did it. */
function findLandedStep(
  input: RunStepInput,
  outputDataset: DatasetDefinition,
  since: Date
): Promise<DatasetVersion | null> {
  return findProducedVersion({
    lakeStorage: input.runtime.lakeStorage,
    datasetId: outputDataset.id,
    producer: { kind: "pipeline", runId: input.job.id, stepId: input.step.id },
    since,
  })
}

/** Record a commit that nothing recorded yet: the step does not run again. */
async function recordLandedStep(
  input: RunStepInput,
  stepRunId: string,
  version: DatasetVersion
): Promise<PipelineStepRunResult> {
  const { runtime, pipeline, step, job } = input

  let stepRun: PipelineStepRunRecord
  try {
    stepRun = await runtime.pipelineRunsStorage.finishStep({
      projectId: runtime.id,
      id: stepRunId,
      executionToken: job.executionToken,
      status: "succeeded",
      output: { datasetId: version.datasetId, versionId: version.versionId },
    })
  } catch (error) {
    throw createStepBookkeepingError({
      pipelineId: pipeline.id,
      pipelineRunId: job.id,
      stepId: step.id,
      stepRunId,
      version,
      cause: error,
    })
  }

  await input.onStepFinished?.(stepRun, stepLifecycle(input))
  return { run: stepRun, version, versionCreated: true }
}

async function executeStep(input: {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly job: PipelineJob
  readonly signal: AbortSignal
  readonly logSession: PipelineLogSession
  readonly outputDataset: DatasetDefinition
  readonly expectedLatestVersionId: string | null
  readonly resolvedInputs: readonly ResolvedStepInput[]
}): Promise<StepExecutionResult> {
  switch (input.step.executor.kind) {
    case "run":
      return executeRunStep(input)
    case "sql":
      return executeSqlStep(input)
  }
}
