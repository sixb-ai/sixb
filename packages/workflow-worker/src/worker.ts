import type {
  DomainEventLog,
  Queues,
  Sixb,
  SixbDefinitions,
  SixbFailure,
  Storage,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure, isSixbError } from "@sixb/core/internal/errors"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import type {
  HeldRunClaim,
  QueueWorkerFailureDecision,
  RunDelivery,
} from "@sixb/core/internal/workers"
import { RunWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, WorkflowQueueJob } from "@sixb/core/queues"
import type {
  WorkflowRunExecution,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { WORKFLOW_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { EventsRuntimeWorkflowRunObserver } from "./events"
import { runWorkflowJob, runWorkflowResumeJob } from "./run-workflow-job"
import type {
  WorkflowRunFailureReporter,
  WorkflowRunObserver,
  WorkflowWorkerContext,
} from "./types"

export interface WorkflowWorkerOptions {
  /** Maximum workflow run jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
}

export class WorkflowWorker extends RunWorker<
  WorkflowQueueJob,
  typeof WORKFLOW_RUN_FAILURE_CODES,
  WorkflowRunRecord
> {
  private readonly host: WorkflowWorkerHost
  private readonly observer: WorkflowRunObserver
  private readonly workflowRuns: WorkflowRunStorage

  constructor(host: WorkflowWorkerHost, options: WorkflowWorkerOptions = {}) {
    if (host.definitions.workflows.list().length === 0) {
      throw new Error("[SixbWorkflowWorker] No workflow definitions are registered.")
    }

    const workflowRuns = host.storage.workflowRuns
    if (!workflowRuns) {
      throw new Error("[SixbWorkflowWorker] Workflow workers require storage.workflowRuns.")
    }

    if (requiresWorkflowInterventionStorage(host) && !host.storage.workflowInterventions) {
      throw new Error(
        "[SixbWorkflowWorker] Workflow workers with intervention nodes require storage.workflowInterventions."
      )
    }

    super({
      projectId: host.id,
      queue: host.queues.workflows,
      failureCodes: WORKFLOW_RUN_FAILURE_CODES,
      workerId: `workflow-worker-${host.id}`,
      claimLimit: options.concurrency,
      runs: workflowRuns,
    })

    this.host = host
    this.observer = new EventsRuntimeWorkflowRunObserver(host.events)
    this.workflowRuns = workflowRuns
  }

  /**
   * A resume wakes a run that waits, which moves it to running itself once it checked what woke it.
   * Any other state it answers from the records. Only a run left running needs claiming.
   */
  protected async claimRun(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    execution: WorkflowRunExecution
  ): Promise<RunDelivery<WorkflowRunRecord>> {
    if (claimed.job.type === "workflow.run.resume.requested") {
      const run = await this.requireWorkflowRun(claimed.job.payload.runId)
      if (run.status !== "running") return { outcome: "woken", run }
    }

    return this.workflowRuns.startOrReclaim({
      projectId: this.host.id,
      id: claimed.job.payload.runId,
      execution,
    })
  }

  protected async executeRun(
    claim: HeldRunClaim<WorkflowRunRecord>,
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const { run, execution } = claim

    if (claim.givenUp) {
      await this.giveUp(run, claimed, claim.givenUp)
      return
    }

    const durableExecution = await this.host.storage.executions.getById({
      projectId: this.host.id,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw new Error(
        `[SixbWorkflowWorker] Workflow run '${run.id}' references missing execution '${run.executionId}'.`
      )
    }
    const executionScope = bindDurablePrimitiveExecution(this.host, {
      execution: durableExecution,
      primitive: { kind: "workflow", id: run.workflowId, runId: run.id },
      modelExecution: {
        attempt: claimed.job.attempt,
        signal,
      },
    })
    const context = buildWorkflowContext(this.host, this.workflowRuns, executionScope.sixb)
    const onRunFailed: WorkflowRunFailureReporter = (error, run, failure) =>
      this.reportFailedRun(claimed, error, run, failure)

    if (claimed.job.type === "workflow.run.resume.requested") {
      await runWorkflowResumeJob({
        runtime: context,
        job: {
          id: run.id,
          workflowId: run.workflowId,
          nodeRunId: claimed.job.payload.nodeRunId,
          execution,
        },
        signal,
        observer: this.observer,
        onRunFailed,
      })
      return
    }

    await runWorkflowJob({
      runtime: context,
      claim,
      job: {
        id: run.id,
        workflowId: run.workflowId,
        input: run.input,
        execution,
      },
      signal,
      observer: this.observer,
      onRunFailed,
    })
  }

  /** End a run that will not be tried again, with whatever node its executions left running. */
  private async giveUp(
    run: WorkflowRunRecord,
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    error: unknown
  ): Promise<SixbFailure<(typeof WORKFLOW_RUN_FAILURE_CODES)[number]>> {
    const failure = captureSixbFailure(error, {
      allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      details: { workflowId: run.workflowId, runId: run.id },
    })

    const { nodes } = await this.workflowRuns.nodes.list({
      projectId: this.host.id,
      workflowRunId: run.id,
      statuses: ["running"],
    })
    for (const node of nodes) {
      await this.workflowRuns.nodes.finish({
        projectId: this.host.id,
        id: node.id,
        executionToken: run.execution?.token,
        status: "failed",
        error: failure,
      })
    }

    const failed = await this.workflowRuns.finish({
      projectId: this.host.id,
      id: run.id,
      executionToken: run.execution?.token,
      status: "failed",
      error: failure,
    })

    await this.observer.onRunFinished(failed)

    this.reportFailedRun(claimed, error, failed, failure)
    return failure
  }

  private async requireWorkflowRun(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.workflowRuns.getById({ projectId: this.host.id, id: runId })
    if (!run) {
      throw new Error(`[SixbWorkflowWorker] Workflow run '${runId}' was not found.`)
    }
    return run
  }

  private reportFailedRun(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    error: unknown,
    run: WorkflowRunRecord,
    failure: Parameters<WorkflowRunFailureReporter>[2]
  ): void {
    reportRunFailure(this.host, error, {
      projectId: this.host.id,
      attempt: claimed.job.attempt,
      runKind: "workflow",
      run: {
        runId: run.id,
        workflowId: run.workflowId,
      },
      failure,
    })
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof WORKFLOW_RUN_FAILURE_CODES)[number]>> {
    // A coded invariant failure is deterministic. Redelivery cannot repair a malformed durable
    // identity edge, so honor the catalog policy before considering infrastructure retries.
    if (isSixbError(error) && !error.retryable) {
      const run = await this.workflowRuns
        .getById({ projectId: this.host.id, id: claimed.job.payload.runId })
        .catch(() => null)

      return run?.status === "running"
        ? { kind: "fail", failure: await this.giveUp(run, claimed, error) }
        : { kind: "fail" }
    }

    return super.onExecutionError(claimed, error)
  }
}

function requiresWorkflowInterventionStorage(host: WorkflowWorkerHost): boolean {
  return host.definitions.workflows
    .list()
    .some((workflow) => workflow.nodes.some((node) => node.type === "intervention"))
}

function buildWorkflowContext(
  host: WorkflowWorkerHost,
  workflowRuns: WorkflowRunStorage,
  sixb: Sixb
): WorkflowWorkerContext {
  return {
    projectId: host.id,
    ontology: host.definitions.ontology,
    storage: host.storage,
    queues: host.queues,
    workflowRuns,
    logging: host.logging,
    sixb,
  }
}

export interface WorkflowWorkerHost extends PrimitiveExecutionHost {
  readonly storage: Storage
  readonly queues: Queues
  readonly events: DomainEventLog
  readonly logging?: LoggingService
  readonly definitions: Pick<SixbDefinitions, "ontology" | "workflows">
}
