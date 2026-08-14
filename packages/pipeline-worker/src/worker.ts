import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { bindPrimitiveExecution } from "@sixb/core/internal/primitive-execution"
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
  PipelineWorkerHost,
} from "./types"

export class PipelineWorker extends QueueWorker<PipelineRunRequestedQueueJob> {
  private readonly context: PipelineWorkerContext
  private readonly host: PipelineWorkerHost

  constructor(host: PipelineWorkerHost) {
    if (host.definitions.pipelines.list().length === 0) {
      throw new Error("[SixbPipelineWorker] No pipeline definitions are registered.")
    }

    const pipelineRunsStorage = host.storage.pipelineRuns
    if (!pipelineRunsStorage) {
      throw new Error("[SixbPipelineWorker] Pipeline workers require storage.pipelineRuns support.")
    }

    super({
      projectId: host.id,
      queue: host.queues.pipelines,
      workerId: `pipeline-worker-${host.id}`,
    })

    this.context = buildPipelineContext(host, pipelineRunsStorage)
    this.host = host
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
    const execution = bindPrimitiveExecution(this.host, {
      primitive: { kind: "pipeline", id: pipelineJob.pipelineId, runId: pipelineJob.id },
      source: { type: "queue", queue: "pipelines", jobId: job.id },
    })
    const context = { ...this.context, id: execution.sixb.execution.projectId }

    let result: PipelineRunResult
    try {
      result = await runPipelineJob({
        runtime: context,
        job: pipelineJob,
        signal,
        onRunStarted: (run) => emitPipelineRunStarted(this.host.events, run),
        onRunFailed: (error, run) => {
          reportRunFailure(this.host, error, {
            projectId: this.host.id,
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
          emitPipelineRunStepStarted(this.host.events, step, context),
        onStepFinished: (step, context) =>
          emitPipelineRunStepFinished(this.host.events, step, context),
        onStepCommitted: (step) => emitDatasetVersionCommitted(this.host.events, pipelineJob, step),
      })
    } catch (error) {
      if (error instanceof PipelineRunAlreadyStartedError) return
      throw error
    }

    await emitPipelineRunFinished(this.host.events, {
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
    await emitPipelineRunFinished(this.host.events, {
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
    await emitPipelineRunFinished(this.host.events, {
      id: pipelineJob.id,
      pipelineId: pipelineJob.pipelineId,
      status: "cancelled",
    })

    return { kind: "fail" }
  }
}

function buildPipelineContext(
  host: PipelineWorkerHost,
  pipelineRunsStorage: PipelineRunStorage
): PipelineWorkerContext {
  return {
    id: host.id,
    pipelineRunsStorage,
    lakeStorage: host.lakeStorage,
    logging: host.logging,
    pipelines: host.definitions.pipelines,
    datasets: host.definitions.datasets,
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
