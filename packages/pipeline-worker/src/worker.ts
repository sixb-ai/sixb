import type { SixbFailure } from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker, retryUnstartedRun } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, PipelineRunRequestedQueueJob } from "@sixb/core/queues"
import {
  PIPELINE_RUN_FAILURE_CODES,
  type PipelineRunFailureCode,
  type PipelineRunRecord,
  type PipelineRunStorage,
} from "@sixb/core/storage"
import {
  emitDatasetVersionCommitted,
  emitPipelineRunFinished,
  emitPipelineRunStarted,
  emitPipelineRunStepFinished,
  emitPipelineRunStepStarted,
} from "./events"
import { PipelineRunAlreadyStartedError, runPipelineJob } from "./run-pipeline-job"
import type { PipelineJob, PipelineWorkerContext, PipelineWorkerHost } from "./types"

export interface PipelineWorkerOptions {
  /** Maximum pipeline run jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
}

export class PipelineWorker extends QueueWorker<
  PipelineRunRequestedQueueJob,
  typeof PIPELINE_RUN_FAILURE_CODES
> {
  private readonly context: PipelineWorkerContext
  private readonly host: PipelineWorkerHost

  constructor(host: PipelineWorkerHost, options: PipelineWorkerOptions = {}) {
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
      claimLimit: options.concurrency,
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

    // Each trigger that joined this run published its own job for it. Once one of them has started
    // the run, the others have nothing left to do.
    if (run.status !== "queued") return

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
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof PIPELINE_RUN_FAILURE_CODES)[number]>> {
    // Pipeline runs are not all-or-nothing in V1. A previous step may have committed an append
    // output, so a job that failed after starting its run must not be retried automatically.
    const run = await this.host.storage.pipelineRuns?.getById({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
    })
    if (run?.status === "queued") {
      const retry = retryUnstartedRun(claimed.job.attempt)
      if (retry) return retry

      return { kind: "fail", failure: await this.failUnstartedRun(claimed, run, error) }
    }

    return run?.status === "failed" && run.error
      ? { kind: "fail", failure: run.error }
      : { kind: "fail" }
  }

  /**
   * Automatic dispatch joins a queued run instead of queueing another, so a run whose job ends
   * before starting it must not stay queued: every later trigger would wait on it forever.
   */
  private async failUnstartedRun(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    run: PipelineRunRecord,
    error: unknown
  ): Promise<SixbFailure<PipelineRunFailureCode>> {
    const failure = captureSixbFailure(error, {
      allowedCodes: PIPELINE_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      details: { pipelineId: run.pipelineId, runId: run.id },
    })

    await this.context.pipelineRunsStorage.finish({
      projectId: this.host.id,
      id: run.id,
      status: "failed",
      error: failure,
    })

    reportRunFailure(this.host, error, {
      projectId: this.host.id,
      attempt: claimed.job.attempt,
      runKind: "pipeline",
      run: { runId: run.id, pipelineId: run.pipelineId },
      failure,
    })
    return failure
  }

  protected override async onAbortError(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof PIPELINE_RUN_FAILURE_CODES)[number]>> {
    const run = await this.host.storage.pipelineRuns?.getById({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
    })
    if (!run) return { kind: "fail" }

    if (!(await hasCommittedStep(this.context, run.id))) {
      return { kind: "retry" }
    }

    // After a step commit, rerunning the whole pipeline could duplicate append outputs.
    return run.status === "cancelled" && run.error
      ? { kind: "fail", failure: run.error }
      : { kind: "fail" }
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
