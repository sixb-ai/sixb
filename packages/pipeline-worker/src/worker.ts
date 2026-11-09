import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { type HeldRunClaim, RunWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, PipelineRunRequestedQueueJob } from "@sixb/core/queues"
import {
  PIPELINE_RUN_FAILURE_CODES,
  type PipelineRunRecord,
  type PipelineRunStorage,
  type RunClaim,
  type RunExecution,
} from "@sixb/core/storage"
import {
  emitDatasetVersionCommitted,
  emitPipelineRunFinished,
  emitPipelineRunStarted,
  emitPipelineRunStepFinished,
  emitPipelineRunStepStarted,
} from "./events"
import { runPipelineJob } from "./run-pipeline-job"
import type { PipelineWorkerContext, PipelineWorkerHost, RunPipelineJobInput } from "./types"

export interface PipelineWorkerOptions {
  /** Maximum pipeline run jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
}

export class PipelineWorker extends RunWorker<
  PipelineRunRequestedQueueJob,
  typeof PIPELINE_RUN_FAILURE_CODES,
  PipelineRunRecord
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
      runs: pipelineRunsStorage,
      executions: host.storage.executions,
    })

    this.context = buildPipelineContext(host, pipelineRunsStorage)
    this.host = host
  }

  protected claimRun(
    claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    execution: RunExecution
  ): Promise<RunClaim<PipelineRunRecord>> {
    return this.context.pipelineRunsStorage.startOrReclaim({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
      execution,
    })
  }

  protected async executeRun(
    claim: HeldRunClaim<PipelineRunRecord>,
    _claimed: ClaimedQueueJob<PipelineRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { run } = claim
    const durableExecution = await this.requireExecution(run)

    // Pipeline steps currently use host-owned lake and run storage directly. Binding still happens
    // here so the durable execution and its trusted primitive authority are validated before work.
    bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: { kind: "pipeline", id: run.pipelineId, runId: run.id },
    })

    await runPipelineJob({
      runtime: this.context,
      claim,
      signal,
      ...this.hooksFor(run, durableExecution.correlationId),
    })
  }

  /** What a run tells others as it goes, all under the correlation id of its execution. */
  private hooksFor(
    run: PipelineRunRecord,
    correlationId: string
  ): Omit<RunPipelineJobInput, "runtime" | "claim" | "signal"> {
    const { events } = this.host

    return {
      onRunStarted: (started) => emitPipelineRunStarted(events, started, correlationId),
      onRunFinished: (finished) => emitPipelineRunFinished(events, finished, correlationId),

      onRunFailed: (error, failed, failure) => {
        reportRunFailure(this.host, error, {
          projectId: this.host.id,
          attempt: failed.attempt,
          runKind: "pipeline",
          run: { runId: failed.id, pipelineId: failed.pipelineId },
          failure,
        })
      },

      onStepStarted: (step, context) =>
        emitPipelineRunStepStarted(events, step, context, correlationId),

      onStepFinished: (step, context) =>
        emitPipelineRunStepFinished(events, step, context, correlationId),

      onStepCommitted: (step) =>
        emitDatasetVersionCommitted(
          events,
          { id: run.id, pipelineId: run.pipelineId },
          step,
          correlationId
        ),
    }
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
