import type {
  DomainEventLog,
  OntologySource,
  Queues,
  Sixb,
  SixbDefinitions,
  Storage,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { isSixbError } from "@sixb/core/internal/errors"
import type { LoggingService } from "@sixb/core/internal/logging"
import {
  bindDurablePrimitiveExecution,
  type PrimitiveExecutionHost,
} from "@sixb/core/internal/primitive-execution"
import type { QueueDelivery, QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
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

const MAX_WORKFLOW_DELIVERY_ATTEMPTS = 5
const WORKFLOW_RETRY_BACKOFF_MS = 1_000

export interface WorkflowWorkerOptions {
  /** Maximum workflow run jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
}

export class WorkflowWorker extends QueueWorker<
  WorkflowQueueJob,
  typeof WORKFLOW_RUN_FAILURE_CODES
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
    })

    this.host = host
    this.observer = new EventsRuntimeWorkflowRunObserver(host.events)
    this.workflowRuns = workflowRuns
  }

  protected async execute(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<WorkflowQueueJob, (typeof WORKFLOW_RUN_FAILURE_CODES)[number]>
  ): Promise<void> {
    const execution = freshWorkflowExecution(delivery.leaseExpiresAt)
    const runId = claimed.job.payload.runId
    const run = await this.requireWorkflowRun(runId)
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
    })
    const context = buildWorkflowContext(this.host, this.workflowRuns, executionScope.sixb)
    const stopOwnershipProjection = delivery.onLeaseRenewed((renewed) => {
      void this.projectExecutionOwnership(runId, execution.token, renewed.leaseExpiresAt)
    })

    try {
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
          onRunFailed: (error, run, failure) => this.reportFailedRun(claimed, error, run, failure),
        })
        return
      }

      await runWorkflowJob({
        runtime: context,
        job: {
          id: run.id,
          workflowId: run.workflowId,
          input: run.input,
          execution,
        },
        signal,
        observer: this.observer,
        onRunFailed: (error, run, failure) => this.reportFailedRun(claimed, error, run, failure),
      })
    } finally {
      stopOwnershipProjection()
    }
  }

  private async requireWorkflowRun(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.workflowRuns.getById({ projectId: this.host.id, id: runId })
    if (!run) {
      throw new Error(`[SixbWorkflowWorker] Workflow run '${runId}' was not found.`)
    }
    return run
  }

  private async projectExecutionOwnership(
    runId: string,
    executionToken: string,
    queueLeaseExpiresAt: string
  ): Promise<void> {
    try {
      await this.workflowRuns.confirmExecutionOwnership({
        projectId: this.host.id,
        id: runId,
        executionToken,
        queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
      })
    } catch (error) {
      const run = await this.workflowRuns
        .getById({ projectId: this.host.id, id: runId })
        .catch(() => null)
      if (run?.status === "running" && run.execution?.token === executionToken) {
        console.error(
          `[SixbWorkflowWorker] Could not project queue ownership for workflow run '${runId}'.`,
          error
        )
      }
    }
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
      return { kind: "fail" }
    }

    const run = await this.workflowRuns
      .getById({
        projectId: this.host.id,
        id: claimed.job.payload.runId,
      })
      .catch(() => null)
    if ((run?.status === "failed" || run?.status === "cancelled") && run.error) {
      return { kind: "fail", failure: run.error }
    }
    if (
      (!run || run.status === "queued" || run.status === "running") &&
      claimed.job.attempt < MAX_WORKFLOW_DELIVERY_ATTEMPTS
    ) {
      return {
        kind: "retry",
        availableAt: new Date(Date.now() + WORKFLOW_RETRY_BACKOFF_MS).toISOString(),
      }
    }
    return { kind: "fail" }
  }

  protected override async onAbortError(
    _claimed: ClaimedQueueJob<WorkflowQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return {
      kind: "retry",
      availableAt: new Date(Date.now() + WORKFLOW_RETRY_BACKOFF_MS).toISOString(),
    }
  }
}

function requiresWorkflowInterventionStorage(host: WorkflowWorkerHost): boolean {
  return host.definitions.workflows
    .list()
    .some((workflow) => workflow.nodes.some((node) => node.type === "intervention"))
}

function freshWorkflowExecution(queueLeaseExpiresAt: string): WorkflowRunExecution {
  return {
    token: `wfx_${crypto.randomUUID()}`,
    queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
  }
}

function buildWorkflowContext(
  host: WorkflowWorkerHost,
  workflowRuns: WorkflowRunStorage,
  sixb: Sixb<readonly OntologySource[]>
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
