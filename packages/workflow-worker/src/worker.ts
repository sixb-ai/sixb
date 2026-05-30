import type {
  ClaimedQueueJob,
  QueueWorkerFailureDecision,
  WorkflowRunRequestedQueueJob,
  WorkflowRunStorage,
} from "@pario/core"
import { QueueWorker } from "@pario/core"
import { EventsRuntimeWorkflowRunObserver } from "./events"
import { runWorkflowJob } from "./run-workflow-job"
import type {
  WorkflowJob,
  WorkflowRunObserver,
  WorkflowWorkerContext,
  WorkflowWorkerPario,
} from "./types"

export class WorkflowWorker extends QueueWorker<WorkflowRunRequestedQueueJob> {
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

    super({
      projectId: pario.projectId,
      queue: pario.queues.workflows,
      workerId: `workflow-worker-${pario.id}`,
    })

    this.context = buildWorkflowContext(pario, workflowRuns)
    this.observer = new EventsRuntimeWorkflowRunObserver(pario.events)
  }

  protected async execute(
    claimed: ClaimedQueueJob<WorkflowRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const workflowJob = workflowJobFromClaimed(claimed)

    await runWorkflowJob({
      runtime: this.context,
      job: workflowJob,
      signal,
      observer: this.observer,
    })
  }

  protected override async onExecutionError(
    _claimed: ClaimedQueueJob<WorkflowRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return { kind: "fail" }
  }

  protected override async onAbortError(
    _claimed: ClaimedQueueJob<WorkflowRunRequestedQueueJob>,
    _error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    return { kind: "fail" }
  }
}

function workflowJobFromClaimed(
  claimed: ClaimedQueueJob<WorkflowRunRequestedQueueJob>
): WorkflowJob {
  const { job } = claimed
  return {
    id: job.payload.runId ?? `${job.id}:attempt:${job.attempt}`,
    workflowId: job.payload.workflowId,
    input: job.payload.input,
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
