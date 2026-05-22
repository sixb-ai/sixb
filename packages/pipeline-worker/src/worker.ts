import type {
  ClaimedQueueJob,
  PipelineRunRequestedQueueJob,
  PipelineRunStorage,
  QueueWorkerFailureDecision,
} from "@pario/core"
import { QueueWorker } from "@pario/core"
import {
  emitDatasetVersionCommitted,
  emitPipelineRunFinished,
  emitPipelineRunStarted,
  emitPipelineRunStepFinished,
  emitPipelineRunStepStarted,
} from "./events"
import { runPipelineJob } from "./run-pipeline-job"
import type { PipelineJob, PipelineWorkerContext, PipelineWorkerPario } from "./types"

export class PipelineWorker extends QueueWorker<PipelineRunRequestedQueueJob> {
  private readonly context: PipelineWorkerContext
  private readonly pario: PipelineWorkerPario

  constructor(pario: PipelineWorkerPario) {
    if (pario.getPipelineDefinitions().length === 0) {
      throw new Error("[ParioPipelineWorker] No pipeline definitions are registered.")
    }

    const pipelineRunsStorage = pario.storage.pipelineRuns
    if (!pipelineRunsStorage) {
      throw new Error(
        "[ParioPipelineWorker] Pipeline workers require storage.pipelineRuns support."
      )
    }

    super({
      projectId: pario.id,
      queue: pario.queues.pipelines,
      workerId: `pipeline-worker-${pario.id}`,
    })

    this.context = buildPipelineContext(pario, pipelineRunsStorage)
    this.pario = pario
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

    const result = await runPipelineJob({
      runtime: this.context,
      job: pipelineJob,
      signal,
      onRunStarted: (run) => emitPipelineRunStarted(this.pario.events, run),
      onStepStarted: (step, context) =>
        emitPipelineRunStepStarted(this.pario.events, step, context),
      onStepFinished: (step, context) =>
        emitPipelineRunStepFinished(this.pario.events, step, context),
      onStepCommitted: (step) => emitDatasetVersionCommitted(this.pario, pipelineJob, step),
    })

    await emitPipelineRunFinished(this.pario.events, {
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
    await emitPipelineRunFinished(this.pario.events, {
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
    await emitPipelineRunFinished(this.pario.events, {
      id: pipelineJob.id,
      pipelineId: pipelineJob.pipelineId,
      status: "cancelled",
    })

    return { kind: "fail" }
  }
}

function buildPipelineContext(
  pario: PipelineWorkerPario,
  pipelineRunsStorage: PipelineRunStorage
): PipelineWorkerContext {
  return {
    id: pario.id,
    pipelineRunsStorage,
    lakeStorage: pario.lakeStorage,
    getPipelineById(pipelineId) {
      return pario.getPipelineById(pipelineId)
    },
    getDatasetById(datasetId) {
      return pario.getDatasetById(datasetId)
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
