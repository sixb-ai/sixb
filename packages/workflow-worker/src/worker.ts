import { reportRunFailure } from "@sixb/core/internal/error-reporting"
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
  WorkflowWorkerSixb,
} from "./types"

const MAX_WORKFLOW_DELIVERY_ATTEMPTS = 5
const WORKFLOW_RETRY_BACKOFF_MS = 1_000

export class WorkflowWorker extends QueueWorker<WorkflowQueueJob> {
  private readonly context: WorkflowWorkerContext
  private readonly observer: WorkflowRunObserver
  private readonly sixb: WorkflowWorkerSixb

  constructor(sixb: WorkflowWorkerSixb) {
    if (sixb.workflows.list().length === 0) {
      throw new Error("[SixbWorkflowWorker] No workflow definitions are registered.")
    }

    const workflowRuns = sixb.storage.workflowRuns
    if (!workflowRuns) {
      throw new Error("[SixbWorkflowWorker] Workflow workers require storage.workflowRuns.")
    }

    if (requiresWorkflowInterventionStorage(sixb) && !sixb.storage.workflowInterventions) {
      throw new Error(
        "[SixbWorkflowWorker] Workflow workers with intervention nodes require storage.workflowInterventions."
      )
    }

    super({
      projectId: sixb.projectId,
      queue: sixb.queues.workflows,
      workerId: `workflow-worker-${sixb.id}`,
      host: sixb,
    })

    this.context = buildWorkflowContext(sixb, workflowRuns)
    this.observer = new EventsRuntimeWorkflowRunObserver(sixb.events)
    this.sixb = sixb
  }

  protected async execute(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<WorkflowQueueJob>
  ): Promise<void> {
    const execution = freshWorkflowExecution(delivery.leaseExpiresAt)
    const runId = workflowRunIdFromClaimed(claimed)
    const stopOwnershipProjection = delivery.onLeaseRenewed((renewed) => {
      void this.projectExecutionOwnership(runId, execution.token, renewed.leaseExpiresAt)
    })

    try {
      if (claimed.job.type === "workflow.run.resume.requested") {
        await runWorkflowResumeJob({
          runtime: this.context,
          job: workflowResumeJobFromClaimed(claimed, execution),
          signal,
          observer: this.observer,
          onRunFailed: (error, run) => this.reportFailedRun(claimed, error, run),
        })
        return
      }

      const workflowJob = workflowJobFromClaimed(claimed, execution)

      await runWorkflowJob({
        runtime: this.context,
        job: workflowJob,
        signal,
        observer: this.observer,
        onRunFailed: (error, run) => this.reportFailedRun(claimed, error, run),
      })
    } finally {
      stopOwnershipProjection()
    }
  }

  private async projectExecutionOwnership(
    runId: string,
    executionToken: string,
    queueLeaseExpiresAt: string
  ): Promise<void> {
    try {
      await this.context.workflowRuns.confirmExecutionOwnership({
        projectId: this.context.projectId,
        id: runId,
        executionToken,
        queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
      })
    } catch (error) {
      const run = await this.context.workflowRuns
        .getById({ projectId: this.context.projectId, id: runId })
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
    reportRunFailure(this.sixb, error, {
      projectId: this.sixb.projectId,
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
    const run = await this.context.workflowRuns
      .getById({
        projectId: this.context.projectId,
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

function requiresWorkflowInterventionStorage(sixb: WorkflowWorkerSixb): boolean {
  return sixb.workflows
    .list()
    .some((workflow) => workflow.nodes.some((node) => node.type === "intervention"))
}

function workflowJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowQueueJob>,
  execution: WorkflowRunExecution
): WorkflowJob {
  const { job } = claimed
  if (job.type !== "workflow.run.requested") {
    throw new Error(`[SixbWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
    workflowId: job.payload.workflowId,
    input: job.payload.input,
    source: job.payload.source,
    execution,
  }
}

function workflowResumeJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowQueueJob>,
  execution: WorkflowRunExecution
): WorkflowResumeJob {
  const { job } = claimed
  if (job.type !== "workflow.run.resume.requested") {
    throw new Error(`[SixbWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: job.payload.runId,
    workflowId: job.payload.workflowId,
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
  sixb: WorkflowWorkerSixb,
  workflowRuns: WorkflowRunStorage
): WorkflowWorkerContext {
  return {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
    storage: sixb.storage,
    lakeStorage: sixb.lakeStorage,
    blobStorage: sixb.blobStorage,
    queues: sixb.queues,
    rules: sixb.rules,
    workflowRuns,
    logs: sixb.logs,
    sixb: sixb as unknown as WorkflowWorkerContext["sixb"],
    getWorkflowById(workflowId) {
      return sixb.workflows.getById(workflowId)
    },
  }
}
