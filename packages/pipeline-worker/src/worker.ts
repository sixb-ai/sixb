import type {
  ClaimedQueueJob,
  PipelineRunRequestedQueueJob,
  PipelineRunStorage,
  QueueWorkerFailureDecision,
} from "@sixb/core"
import { QueueWorker } from "@sixb/core"
import {
  emitDatasetVersionCommitted,
  emitPipelineRunFinished,
  emitPipelineRunStarted,
  emitPipelineRunStepFinished,
  emitPipelineRunStepStarted,
} from "./events"
import { runPipelineJob } from "./run-pipeline-job"
import type { PipelineJob, PipelineWorkerContext, PipelineWorkerSixb } from "./types"

export class PipelineWorker extends QueueWorker<PipelineRunRequestedQueueJob> {
  private readonly context: PipelineWorkerContext | null
  private readonly sixb: PipelineWorkerSixb

  constructor(sixb: PipelineWorkerSixb) {
    const idle = sixb.getPipelineDefinitions().length === 0

    super({
      projectId: sixb.id,
      queue: sixb.queues.pipelines,
      workerId: `pipeline-worker-${sixb.id}`,
      idle,
    })

    this.sixb = sixb

    if (idle) {
      console.log("[SixbPipelineWorker] No pipeline definitions are registered; worker will idle.")
      this.context = null
      return
    }

    const pipelineRunsStorage = sixb.storage.pipelineRuns
    if (!pipelineRunsStorage) {
      throw new Error("[SixbPipelineWorker] Pipeline workers require storage.pipelineRuns support.")
    }

    this.context = buildPipelineContext(sixb, pipelineRunsStorage)
  }

  protected async execute(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const context = this.requireContext()
    const { job } = claimed
    const pipelineJob: PipelineJob = {
      id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
      pipelineId: job.payload.pipelineId,
    }

    const result = await runPipelineJob({
      runtime: context,
      job: pipelineJob,
      signal,
      onRunStarted: (run) => emitPipelineRunStarted(this.sixb.events, run),
      onStepStarted: (step, context) => emitPipelineRunStepStarted(this.sixb.events, step, context),
      onStepFinished: (step, context) =>
        emitPipelineRunStepFinished(this.sixb.events, step, context),
      onStepCommitted: (step) => emitDatasetVersionCommitted(this.sixb, pipelineJob, step),
    })

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

    if (!(await hasCommittedStep(this.requireContext(), pipelineJob.id))) {
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

  private requireContext(): PipelineWorkerContext {
    if (!this.context) {
      throw new Error("[SixbPipelineWorker] No pipeline definitions are registered.")
    }
    return this.context
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
