import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { ClaimedQueueJob, WorkflowQueueJob } from "@sixb/core/queues"
import type { WorkflowRunRecord, WorkflowRunStorage } from "@sixb/core/storage"
import { EventsRuntimeWorkflowRunObserver } from "./events"
import { runWorkflowJob, runWorkflowResumeJob } from "./run-workflow-job"
import type {
  WorkflowJob,
  WorkflowResumeJob,
  WorkflowRunObserver,
  WorkflowWorkerContext,
  WorkflowWorkerSixb,
} from "./types"

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
    })

    this.context = buildWorkflowContext(sixb, workflowRuns)
    this.observer = new EventsRuntimeWorkflowRunObserver(sixb.events)
    this.sixb = sixb
  }

  protected async execute(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    if (claimed.job.type === "workflow.run.resume.requested") {
      await runWorkflowResumeJob({
        runtime: this.context,
        job: workflowResumeJobFromClaimed(claimed),
        signal,
        observer: this.observer,
        onRunFailed: (error, run) => this.reportFailedRun(claimed, error, run),
      })
      return
    }

    const workflowJob = workflowJobFromClaimed(claimed)

    await runWorkflowJob({
      runtime: this.context,
      job: workflowJob,
      signal,
      observer: this.observer,
      onRunFailed: (error, run) => this.reportFailedRun(claimed, error, run),
    })
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
    _claimed: ClaimedQueueJob<WorkflowQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return { kind: "fail" }
  }

  protected override async onAbortError(
    _claimed: ClaimedQueueJob<WorkflowQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return { kind: "fail" }
  }
}

function requiresWorkflowInterventionStorage(sixb: WorkflowWorkerSixb): boolean {
  return sixb.workflows
    .list()
    .some((workflow) => workflow.nodes.some((node) => node.type === "intervention"))
}

function workflowJobFromClaimed(claimed: ClaimedQueueJob<WorkflowQueueJob>): WorkflowJob {
  const { job } = claimed
  if (job.type !== "workflow.run.requested") {
    throw new Error(`[SixbWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
    workflowId: job.payload.workflowId,
    input: job.payload.input,
    source: job.payload.source,
  }
}

function workflowResumeJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowQueueJob>
): WorkflowResumeJob {
  const { job } = claimed
  if (job.type !== "workflow.run.resume.requested") {
    throw new Error(`[SixbWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: job.payload.runId,
    workflowId: job.payload.workflowId,
    pendingInterventionId: job.payload.pendingInterventionId,
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
