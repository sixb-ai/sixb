import type { PipelineDefinition, SixbFailure } from "@sixb/core"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type { DatasetVersionRef } from "@sixb/core/lake-storage"
import {
  PIPELINE_RUN_FAILURE_CODES,
  type PipelineRunFailureCode,
  type PipelineRunRecord,
  type PipelineStepRunRecord,
} from "@sixb/core/storage"
import {
  CommitNotRecordedError,
  createPipelineBookkeepingError,
  createPipelineStepFailure,
  requireFinishedAt,
  requirePipeline,
  statusForFailure,
  throwIfAborted,
  unwrapPipelineStepFailure,
} from "./errors"
import { runStep } from "./run-step"
import type {
  PipelineRunFinishedHandler,
  PipelineRunResult,
  PipelineStepRunResult,
  RunPipelineJobInput,
} from "./types"

/**
 * Run what is left of one Pipeline run this delivery holds, and record how it ended.
 *
 * A run that resumes goes through the steps in order and skips those on record as succeeded: the
 * first one that is not is where the last execution stopped.
 *
 * A stopped worker writes nothing here: the run stays running, and the next delivery takes it up.
 */
export async function runPipelineJob(input: RunPipelineJobInput): Promise<PipelineRunResult> {
  const { runtime, claim } = input
  const { run: durableRun } = claim
  const job = {
    id: durableRun.id,
    pipelineId: durableRun.pipelineId,
    executionToken: claim.execution.token,
  }
  const signal = input.signal ?? new AbortController().signal

  if (durableRun.projectId !== runtime.id) {
    throw new Error(
      `[SixbPipelineWorker] Pipeline run '${durableRun.id}' belongs to project '${durableRun.projectId}', not '${runtime.id}'.`
    )
  }

  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "pipeline",
    id: job.id,
  })
  const steps: PipelineStepRunResult[] = []
  let output: DatasetVersionRef | undefined
  let finished = false

  throwIfAborted(signal)

  try {
    if (claim.outcome === "started") await input.onRunStarted?.(durableRun)

    const pipeline = requirePipeline(runtime.pipelines.getById(job.pipelineId), job)
    const recordedSteps = await readRecordedSteps(input)

    for (const [stepIndex, node] of pipeline.graph.nodes.entries()) {
      const recorded = recordedSteps.get(node.step.id)

      if (recorded?.status === "succeeded") {
        output = recorded.output
        continue
      }

      // The execution that ended this step died before ending the run with it.
      if (recorded && recorded.status !== "running") {
        throw createPipelineStepFailure({
          pipelineId: pipeline.id,
          pipelineRunId: job.id,
          stepId: node.step.id,
          stepRunId: recorded.id,
          cause: new Error(recorded.error?.message ?? `Step ended as ${recorded.status}.`),
        })
      }

      const stepResult = await runStep({
        runtime,
        pipeline,
        step: node.step,
        stepIndex,
        job,
        signal,
        logSession,
        recorded,
        givenUp: claim.givenUp,
        onStepStarted: input.onStepStarted,
        onStepFinished: input.onStepFinished,
      })

      steps.push(stepResult)
      output = stepResult.version
      // This is the durability boundary for per-step output events.
      await input.onStepCommitted?.(stepResult)
    }

    await cancelStepsNoLongerDefined(input, pipeline, recordedSteps)

    let run: PipelineRunRecord
    try {
      run = await runtime.pipelineRunsStorage.finish({
        projectId: runtime.id,
        id: job.id,
        executionToken: job.executionToken,
        status: "succeeded",
        output: output ? { datasetId: output.datasetId, versionId: output.versionId } : undefined,
      })
    } catch (error) {
      if (output) {
        throw createPipelineBookkeepingError({
          pipelineId: pipeline.id,
          runId: job.id,
          version: output,
          cause: error,
        })
      }
      throw error
    }
    const finishedRun = {
      ...run,
      finishedAt: requireFinishedAt({
        pipelineId: pipeline.id,
        runId: job.id,
        finishedAt: run.finishedAt,
      }),
    }

    finished = true
    await notifyRunFinished(input.onRunFinished, finishedRun)
    return { run: finishedRun, steps, version: steps.at(-1)?.version }
  } catch (error) {
    const reportedError = unwrapPipelineStepFailure(error)

    if (!finished && !signal.aborted && !(error instanceof CommitNotRecordedError)) {
      const status = statusForFailure(error)
      try {
        const failure = captureSixbFailure(error, {
          allowedCodes: PIPELINE_RUN_FAILURE_CODES,
          defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
          details: { pipelineId: durableRun.pipelineId, runId: job.id },
        })
        if (reportedError === claim.givenUp) await failRunningSteps(input, failure)

        const run = await runtime.pipelineRunsStorage.finish({
          projectId: runtime.id,
          id: job.id,
          executionToken: job.executionToken,
          status,
          error: failure,
        })
        if (status === "failed") input.onRunFailed?.(reportedError, run, failure)
        await notifyRunFinished(input.onRunFinished, run)
      } catch {
        // The run did not transition: a later delivery, or the execution that holds it, ends it.
      }
    }

    throw reportedError
  } finally {
    await logSession.flush()
  }
}

/**
 * What earlier executions recorded of this run, by step id: a deploy can move a step, and a step
 * that committed must be found wherever it now stands. A run that just started has no history.
 */
async function readRecordedSteps(
  input: RunPipelineJobInput
): Promise<ReadonlyMap<string, PipelineStepRunRecord>> {
  if (input.claim.outcome === "started") return new Map()

  const { steps } = await input.runtime.pipelineRunsStorage.listSteps({
    projectId: input.runtime.id,
    pipelineRunId: input.claim.run.id,
    order: "asc",
  })

  return new Map(steps.map((step) => [step.stepId, step]))
}

/** A step a deploy removed was left running by an execution that is gone, and nothing resumes it. */
async function cancelStepsNoLongerDefined(
  input: RunPipelineJobInput,
  pipeline: PipelineDefinition,
  recordedSteps: ReadonlyMap<string, PipelineStepRunRecord>
): Promise<void> {
  const defined = new Set(pipeline.graph.nodes.map((node) => node.step.id))

  for (const step of recordedSteps.values()) {
    if (step.status === "running" && !defined.has(step.stepId)) {
      await input.runtime.pipelineRunsStorage.finishStep({
        projectId: input.runtime.id,
        id: step.id,
        executionToken: input.claim.execution.token,
        status: "cancelled",
      })
    }
  }
}

/** A run given up on ends with the steps its lost executions left running. */
async function failRunningSteps(
  input: RunPipelineJobInput,
  failure: SixbFailure<PipelineRunFailureCode>
): Promise<void> {
  const { runtime, claim } = input
  const { steps } = await runtime.pipelineRunsStorage.listSteps({
    projectId: runtime.id,
    pipelineRunId: claim.run.id,
    statuses: ["running"],
  })

  for (const step of steps) {
    await runtime.pipelineRunsStorage.finishStep({
      projectId: runtime.id,
      id: step.id,
      executionToken: claim.execution.token,
      status: "failed",
      error: failure,
    })
  }
}

async function notifyRunFinished(
  handler: PipelineRunFinishedHandler | undefined,
  run: PipelineRunRecord
): Promise<void> {
  try {
    await handler?.(run)
  } catch (error) {
    // The built-in event log reports lost batches itself. Anything reaching here is a broken
    // invariant in a custom lifecycle handler and must not change an already durable outcome.
    console.error("[SixbPipelineWorker] Pipeline run lifecycle handler failed:", error)
  }
}
