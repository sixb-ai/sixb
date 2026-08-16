import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, PipelineRunRequestedQueueJob } from "@sixb/core/queues"
import { PIPELINE_RUN_FAILURE_CODES, type PipelineRunStorage } from "@sixb/core/storage"
import {
  emitDatasetVersionCommitted,
  emitPipelineRunFinished,
  emitPipelineRunStarted,
  emitPipelineRunStepFinished,
  emitPipelineRunStepStarted,
} from "./events"
import { PipelineRunAlreadyStartedError, runPipelineJob } from "./run-pipeline-job"
import type { PipelineJob, PipelineWorkerContext, PipelineWorkerHost } from "./types"

export class PipelineWorker extends QueueWorker<
  PipelineRunRequestedQueueJob,
  typeof PIPELINE_RUN_FAILURE_CODES
> {
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
      failureCodes: PIPELINE_RUN_FAILURE_CODES,
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
    const pipelineRuns = this.host.storage.pipelineRuns
    if (!pipelineRuns) {
      throw new Error("[SixbPipelineWorker] Pipeline workers require storage.pipelineRuns support.")
    }
    const run = await pipelineRuns.getById({ projectId: this.host.id, id: job.payload.runId })
    if (!run) {
      throw new Error(`[SixbPipelineWorker] Pipeline run '${job.payload.runId}' was not found.`)
    }

    const durableExecution = await this.host.storage.executions.getById({
      projectId: this.host.id,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw new Error(
        `[SixbPipelineWorker] Pipeline run '${run.id}' references missing execution '${run.executionId}'.`
      )
    }

    const pipelineJob: PipelineJob = {
      id: run.id,
      pipelineId: run.pipelineId,
    }
    // Pipeline steps currently use host-owned lake and run storage directly. Binding still happens
    // here so the durable execution and its trusted primitive authority are validated before work.
    bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: { kind: "pipeline", id: run.pipelineId, runId: run.id },
    })

    try {
      await runPipelineJob({
        runtime: this.context,
        run,
        signal,
        onRunStarted: (run) =>
          emitPipelineRunStarted(this.host.events, run, durableExecution.correlationId),
        onRunFinished: (run) =>
          emitPipelineRunFinished(this.host.events, run, durableExecution.correlationId),
        onRunFailed: (error, run, failure) => {
          reportRunFailure(this.host, error, {
            projectId: this.host.id,
            attempt: job.attempt,
            runKind: "pipeline",
            run: {
              runId: run.id,
              pipelineId: run.pipelineId,
            },
            failure,
          })
        },
        onStepStarted: (step, context) =>
          emitPipelineRunStepStarted(
            this.host.events,
            step,
            context,
            durableExecution.correlationId
          ),
        onStepFinished: (step, context) =>
          emitPipelineRunStepFinished(
            this.host.events,
            step,
            context,
            durableExecution.correlationId
          ),
        onStepCommitted: (step) =>
          emitDatasetVersionCommitted(
            this.host.events,
            pipelineJob,
            step,
            durableExecution.correlationId
          ),
      })
    } catch (error) {
      if (error instanceof PipelineRunAlreadyStartedError) return
      throw error
    }
  }

  protected override async onExecutionError(
    _claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    // Pipeline runs are not all-or-nothing in V1. A previous step may have committed an append
    // output, so failed pipeline jobs must not be retried automatically.
    return { kind: "fail" }
  }

  protected override async onAbortError(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const run = await this.host.storage.pipelineRuns?.getById({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
    })
    if (!run) return { kind: "fail" }

    if (!(await hasCommittedStep(this.context, run.id))) {
      return { kind: "retry" }
    }

    // After a step commit, rerunning the whole pipeline could duplicate append outputs.
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
