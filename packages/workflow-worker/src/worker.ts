import type {
  ClaimedQueueJob,
  QueueWorkerFailureDecision,
  WorkflowQueueJob,
  WorkflowRunStorage,
} from "@pario/core"
import { QueueWorker } from "@pario/core"
import { EventsRuntimeWorkflowRunObserver } from "./events"
import { runWorkflowJob, runWorkflowResumeJob } from "./run-workflow-job"
import type {
  WorkflowJob,
  WorkflowResumeJob,
  WorkflowRunObserver,
  WorkflowWorkerContext,
  WorkflowWorkerPario,
} from "./types"

export class WorkflowWorker extends QueueWorker<WorkflowQueueJob> {
  private readonly context: WorkflowWorkerContext
  private readonly observer: WorkflowRunObserver

  constructor(pario: WorkflowWorkerPario) {
    if (pario.workflows.list().length === 0) {
      throw new Error("[ParioWorkflowWorker] No workflow definitions are registered.")
    }

    const workflowRuns = pario.storage.workflowRuns
    if (!workflowRuns) {
      throw new Error("[ParioWorkflowWorker] Workflow workers require storage.workflowRuns.")
    }

    if (requiresWorkflowInterventionStorage(pario) && !pario.storage.workflowInterventions) {
      throw new Error(
        "[ParioWorkflowWorker] Workflow workers with intervention nodes require storage.workflowInterventions."
      )
    }

    super({
      projectId: pario.projectId,
      queue: pario.queues.workflows,
      workerId: `workflow-worker-${pario.id}`,
    })

    this.context = buildWorkflowContext(pario, workflowRuns)
    this.observer = new EventsRuntimeWorkflowRunObserver(pario.events)
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
      })
      return
    }

    const workflowJob = workflowJobFromClaimed(claimed)

    await runWorkflowJob({
      runtime: this.context,
      job: workflowJob,
      signal,
      observer: this.observer,
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

function requiresWorkflowInterventionStorage(pario: WorkflowWorkerPario): boolean {
  return pario.workflows
    .list()
    .some((workflow) => workflow.nodes.some((node) => node.type === "intervention"))
}

function workflowJobFromClaimed(claimed: ClaimedQueueJob<WorkflowQueueJob>): WorkflowJob {
  const { job } = claimed
  if (job.type !== "workflow.run.requested") {
    throw new Error(`[ParioWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
    workflowId: job.payload.workflowId,
    input: job.payload.input,
  }
}

function workflowResumeJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowQueueJob>
): WorkflowResumeJob {
  const { job } = claimed
  if (job.type !== "workflow.run.resume.requested") {
    throw new Error(`[ParioWorkflowWorker] Unsupported workflow job type '${job.type}'.`)
  }

  return {
    id: job.payload.runId,
    workflowId: job.payload.workflowId,
    pendingInterventionId: job.payload.pendingInterventionId,
  }
}

function buildWorkflowContext(
  pario: WorkflowWorkerPario,
  workflowRuns: WorkflowRunStorage
): WorkflowWorkerContext {
  return {
    projectId: pario.projectId,
    ontology: pario.ontology,
    actionRegistry: pario.actionRegistry,
    events: pario.events,
    storage: pario.storage,
    lakeStorage: pario.lakeStorage,
    blobStorage: pario.blobStorage,
    queues: pario.queues,
    rules: pario.rules,
    workflowRuns,
    pario: pario as unknown as WorkflowWorkerContext["pario"],
    getWorkflowById(workflowId) {
      return pario.workflows.getById(workflowId)
    },
  }
}
