import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, PipelineRunRequestedQueueJob } from "@sixb/core/queues"
import type { PipelineRunStorage } from "@sixb/core/storage"
import {
  emitDatasetVersionCommitted,
  emitPipelineRunFinished,
  emitPipelineRunStarted,
  emitPipelineRunStepFinished,
  emitPipelineRunStepStarted,
} from "./events"
import { PipelineRunAlreadyStartedError, runPipelineJob } from "./run-pipeline-job"
import type {
  PipelineJob,
  PipelineRunResult,
  PipelineWorkerContext,
  PipelineWorkerSixb,
} from "./types"

export class PipelineWorker extends QueueWorker<PipelineRunRequestedQueueJob> {
  private readonly context: PipelineWorkerContext
  private readonly sixb: PipelineWorkerSixb

  constructor(sixb: PipelineWorkerSixb) {
    if (sixb.listPipelines().length === 0) {
      throw new Error("[SixbPipelineWorker] No pipeline definitions are registered.")
    }

    const pipelineRunsStorage = sixb.storage.pipelineRuns
    if (!pipelineRunsStorage) {
      throw new Error("[SixbPipelineWorker] Pipeline workers require storage.pipelineRuns support.")
    }

    super({
      projectId: sixb.id,
      queue: sixb.queues.pipelines,
      workerId: `pipeline-worker-${sixb.id}`,
      host: sixb,
    })

    this.context = buildPipelineContext(sixb, pipelineRunsStorage)
    this.sixb = sixb
  }

  protected async execute(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { job } = claimed
    const pipelineJob: PipelineJob = {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      pipelineId: job.payload.pipelineId,
    }

    let result: PipelineRunResult
    try {
      result = await runPipelineJob({
        runtime: this.context,
        job: pipelineJob,
        signal,
        onRunStarted: (run) => emitPipelineRunStarted(this.sixb.events, run),
        onRunFailed: (error, run) => {
          reportRunFailure(this.sixb, error, {
            projectId: this.sixb.id,
            occurredAt: run.finishedAt,
            attempt: job.attempt,
            run: {
              kind: "pipeline",
              runId: run.id,
              pipelineId: run.pipelineId,
            },
          })
        },
        onStepStarted: (step, context) =>
          emitPipelineRunStepStarted(this.sixb.events, step, context),
        onStepFinished: (step, context) =>
          emitPipelineRunStepFinished(this.sixb.events, step, context),
        onStepCommitted: (step) => emitDatasetVersionCommitted(this.sixb.events, pipelineJob, step),
      })
    } catch (error) {
      if (error instanceof PipelineRunAlreadyStartedError) return
      throw error
    }

    await emitPipelineRunFinished(this.sixb.events, {
      id: pipelineJob.id,
      pipelineId: pipelineJob.pipelineId,
      status: "succeeded",
      datasetId: result.version?.datasetId,
      versionId: result.version?.versionId,
    })
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const { job } = claimed
    await emitPipelineRunFinished(this.sixb.events, {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      pipelineId: job.payload.pipelineId,
      status: "failed",
    })

    // Pipeline runs are not all-or-nothing in V1. A previous step may have committed an append
    // output, so failed pipeline jobs must not be retried automatically.
    return { kind: "fail" }
  }

  protected override async onAbortError(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const { job } = claimed
    const pipelineJob: PipelineJob = {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      pipelineId: job.payload.pipelineId,
    }

    if (!(await hasCommittedStep(this.context, pipelineJob.id))) {
      return { kind: "retry" }
    }

    // After a step commit, rerunning the whole pipeline could duplicate append outputs.
    await emitPipelineRunFinished(this.sixb.events, {
      id: pipelineJob.id,
      pipelineId: pipelineJob.pipelineId,
      status: "cancelled",
    })

    return { kind: "fail" }
  }
}

function buildPipelineContext(
  sixb: PipelineWorkerSixb,
  pipelineRunsStorage: PipelineRunStorage
): PipelineWorkerContext {
  return {
    id: sixb.id,
    pipelineRunsStorage,
    lakeStorage: sixb.lakeStorage,
    logs: sixb.logs,
    getPipelineById(pipelineId) {
      return sixb.getPipelineById(pipelineId)
    },
    getDatasetById(datasetId) {
      return sixb.getDatasetById(datasetId)
    },
  }
}

async function hasCommittedStep(
  context: PipelineWorkerContext,
  pipelineRunId: string
): Promise<boolean> {
  const result = await context.pipelineRunsStorage.listSteps({
    projectId: context.id,
    pipelineRunId,
    statuses: ["succeeded"],
    limit: 1,
  })

  return result.steps.some((step) => Boolean(step.output))
}
