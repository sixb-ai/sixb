import type {
  DomainEventLog,
  OntologySource,
  Queues,
  Sixb,
  SixbDefinitions,
  Storage,
} from "@sixb/core"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
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
import { EventsRuntimeWorkflowRunObserver } from "./events"
import { runWorkflowJob, runWorkflowResumeJob } from "./run-workflow-job"
import type {
  WorkflowJob,
  WorkflowResumeJob,
  WorkflowRunObserver,
  WorkflowWorkerContext,
} from "./types"

const MAX_WORKFLOW_DELIVERY_ATTEMPTS = 5
const WORKFLOW_RETRY_BACKOFF_MS = 1_000

export class WorkflowWorker extends QueueWorker<WorkflowQueueJob> {
  private readonly host: WorkflowWorkerHost
  private readonly observer: WorkflowRunObserver
  private readonly workflowRuns: WorkflowRunStorage

  constructor(host: WorkflowWorkerHost) {
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
      workerId: `workflow-worker-${host.id}`,
    })

    this.host = host
    this.observer = new EventsRuntimeWorkflowRunObserver(host.events)
    this.workflowRuns = workflowRuns
  }

  protected async execute(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<WorkflowQueueJob>
  ): Promise<void> {
    const execution = freshWorkflowExecution(delivery.leaseExpiresAt)
    const runId = workflowRunIdFromClaimed(claimed)
    const run = await this.requireWorkflowRun(claimed, runId)
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
          job: workflowResumeJobFromClaimed(claimed, run, execution),
          signal,
          observer: this.observer,
          onRunFailed: (error, run) => this.reportFailedRun(claimed, error, run),
        })
        return
      }

      const workflowJob = workflowJobFromClaimed(claimed, run, execution)

      await runWorkflowJob({
        runtime: context,
        job: workflowJob,
        signal,
        observer: this.observer,
        onRunFailed: (error, run) => this.reportFailedRun(claimed, error, run),
      })
    } finally {
      stopOwnershipProjection()
    }
  }

  private async requireWorkflowRun(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    runId: string
  ): Promise<WorkflowRunRecord> {
    const run = await this.workflowRuns.getById({ projectId: this.host.id, id: runId })
    if (!run) {
      throw new Error(`[SixbWorkflowWorker] Workflow run '${runId}' was not found.`)
    }
    if (run.workflowId !== claimed.job.payload.workflowId) {
      throw new Error(
        `[SixbWorkflowWorker] Workflow run '${runId}' belongs to workflow '${run.workflowId}', not '${claimed.job.payload.workflowId}'.`
      )
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
    run: WorkflowRunRecord
  ): void {
    reportRunFailure(this.host, error, {
      projectId: this.host.id,
      occurredAt: run.finishedAt,
      attempt: claimed.job.attempt,
      run: {
        kind: "workflow",
        runId: run.id,
        workflowId: run.workflowId,
      },
    })
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    const run = await this.workflowRuns
      .getById({
        projectId: this.host.id,
        id: workflowRunIdFromClaimed(claimed),
      })
      .catch(() => null)
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

function workflowJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowQueueJob>,
  run: WorkflowRunRecord,
  execution: WorkflowRunExecution
): WorkflowJob {
  const { job } = claimed
  if (job.type !== "workflow.run.requested") {
    throw new Error(`[SixbWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: run.id,
    workflowId: run.workflowId,
    input: run.input,
    execution,
  }
}

function workflowResumeJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowQueueJob>,
  run: WorkflowRunRecord,
  execution: WorkflowRunExecution
): WorkflowResumeJob {
  const { job } = claimed
  if (job.type !== "workflow.run.resume.requested") {
    throw new Error(`[SixbWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: run.id,
    workflowId: run.workflowId,
    resume: job.payload.resume,
    execution,
  }
}

function workflowRunIdFromClaimed(claimed: ClaimedQueueJob<WorkflowQueueJob>): string {
  return claimed.job.type === "workflow.run.resume.requested"
    ? claimed.job.payload.runId
    : (claimed.job.payload.runId ?? `${claimed.job.id}:attempt:${claimed.job.attempt}`)
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
