import type {
  ClaimedQueueJob,
  QueueWorkerFailureDecision,
  WorkflowQueueJob,
  WorkflowRunStorage,
} from "@sixb/core"
import { QueueWorker } from "@sixb/core"
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
  private readonly context: WorkflowWorkerContext | null
  private readonly observer: WorkflowRunObserver

  constructor(sixb: WorkflowWorkerSixb) {
    const idle = sixb.workflows.list().length === 0

    super({
      projectId: sixb.projectId,
      queue: sixb.queues.workflows,
      workerId: `workflow-worker-${sixb.id}`,
      idle,
    })

    this.observer = new EventsRuntimeWorkflowRunObserver(sixb.events)

    if (idle) {
      console.log("[SixbWorkflowWorker] No workflow definitions are registered; worker will idle.")
      this.context = null
      return
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

    this.context = buildWorkflowContext(sixb, workflowRuns)
  }

  protected async execute(
    claimed: ClaimedQueueJob<WorkflowQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const context = this.requireContext()
    if (claimed.job.type === "workflow.run.resume.requested") {
      await runWorkflowResumeJob({
        runtime: context,
        job: workflowResumeJobFromClaimed(claimed),
        signal,
        observer: this.observer,
      })
      return
    }

    const workflowJob = workflowJobFromClaimed(claimed)

    await runWorkflowJob({
      runtime: context,
      job: workflowJob,
      signal,
      observer: this.observer,
    })
  }

  private requireContext(): WorkflowWorkerContext {
    if (!this.context) {
      throw new Error("[SixbWorkflowWorker] No workflow definitions are registered.")
    }
    return this.context
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
    sixb: sixb as unknown as WorkflowWorkerContext["sixb"],
    getWorkflowById(workflowId) {
      return sixb.workflows.getById(workflowId)
    },
  }
}
