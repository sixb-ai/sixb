import type { DomainEventLog, EventDraft } from "@sixb/core"
import type {
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@sixb/core/storage"
import type {
  WorkflowNodeLifecycleContext,
  WorkflowRunObserver,
  WorkflowWaitingLifecycleContext,
} from "./types"

type TerminalWorkflowRunStatus = Exclude<WorkflowRunStatus, "queued" | "running" | "waiting">

/**
 * Publishes workflow lifecycle events, reporting a lost batch instead of throwing it upstream.
 *
 * Callers treat lifecycle notification as best-effort, so a delivery failure has to be visible here
 * or nowhere: every one of these events can be the trigger edge some project handler waits on. That
 * is what `emit` guarantees, which is why this needs nothing from `Sixb` beyond the event log.
 */
export class EventsRuntimeWorkflowRunObserver implements WorkflowRunObserver {
  constructor(private readonly events: DomainEventLog) {}

  private async emit(events: readonly EventDraft[]): Promise<void> {
    await this.events.emit({ events }, { source: "SixbWorkflowWorker" })
  }

  async onRunStarted(run: WorkflowRunRecord): Promise<void> {
    await this.emit([
      {
        type: "workflow.run.started",
        payload: {
          workflowId: run.workflowId,
          runId: run.id,
          startedAt: run.startedAt.toISOString(),
        },
      },
    ])
  }

  async onNodeStarted(
    node: WorkflowNodeRunRecord,
    context: WorkflowNodeLifecycleContext
  ): Promise<void> {
    await this.emit([
      {
        type: "workflow.run.node.started",
        payload: {
          workflowId: node.workflowId,
          runId: node.workflowRunId,
          nodeRunId: node.id,
          nodeIndex: node.nodeIndex,
          totalNodes: context.totalNodes,
          nodeType: node.nodeType,
          nodeId: node.nodeId,
          nodeKey: node.nodeKey,
          startedAt: node.startedAt.toISOString(),
        },
      },
    ])
  }

  async onRunWaiting(
    run: WorkflowRunRecord,
    context: WorkflowWaitingLifecycleContext
  ): Promise<void> {
    await this.emit([
      {
        type: "workflow.run.waiting",
        payload: {
          workflowId: run.workflowId,
          runId: run.id,
          waitingAt: context.waitingAt.toISOString(),
        },
      },
    ])
  }

  async onNodeWaiting(
    node: WorkflowNodeRunRecord,
    context: WorkflowNodeLifecycleContext & WorkflowWaitingLifecycleContext
  ): Promise<void> {
    if (node.nodeType !== "intervention" && node.nodeType !== "agent") {
      throw new Error(
        `[SixbWorkflowWorker] Workflow node run '${node.id}' is waiting, but is not a waitable node.`
      )
    }

    await this.emit([
      {
        type: "workflow.run.node.waiting",
        payload: {
          workflowId: node.workflowId,
          runId: node.workflowRunId,
          nodeRunId: node.id,
          nodeIndex: node.nodeIndex,
          totalNodes: context.totalNodes,
          nodeType: node.nodeType,
          nodeId: node.nodeId,
          nodeKey: node.nodeKey,
          waitingAt: context.waitingAt.toISOString(),
        },
      },
    ])
  }

  async onInterventionRequested(intervention: WorkflowInterventionRecord): Promise<void> {
    await this.emit([
      {
        type: "workflow.intervention.requested",
        payload: {
          workflowId: intervention.workflowId,
          runId: intervention.workflowRunId,
          nodeRunId: intervention.nodeRunId,
          interventionId: intervention.interventionId,
          pendingInterventionId: intervention.id,
          requestedAt: intervention.requestedAt.toISOString(),
        },
      },
    ])
  }

  async onNodeFinished(
    node: WorkflowNodeRunRecord,
    context: WorkflowNodeLifecycleContext
  ): Promise<void> {
    if (!node.finishedAt) {
      throw new Error(`[SixbWorkflowWorker] Workflow node run '${node.id}' has no finishedAt.`)
    }

    await this.emit([
      {
        type: "workflow.run.node.finished",
        payload: {
          workflowId: node.workflowId,
          runId: node.workflowRunId,
          nodeRunId: node.id,
          nodeIndex: node.nodeIndex,
          totalNodes: context.totalNodes,
          nodeType: node.nodeType,
          nodeId: node.nodeId,
          nodeKey: node.nodeKey,
          status: requireTerminalStatus(node.status, `Workflow node run '${node.id}'`),
          finishedAt: node.finishedAt.toISOString(),
          ...(node.error ? { error: node.error.message } : {}),
        },
      },
    ])
  }

  async onRunFinished(run: WorkflowRunRecord): Promise<void> {
    if (!run.finishedAt) {
      throw new Error(`[SixbWorkflowWorker] Workflow run '${run.id}' has no finishedAt.`)
    }

    await this.emit([
      {
        type: "workflow.run.finished",
        payload: {
          workflowId: run.workflowId,
          runId: run.id,
          status: requireTerminalStatus(run.status, `Workflow run '${run.id}'`),
          finishedAt: run.finishedAt.toISOString(),
          ...(run.error ? { error: run.error.message } : {}),
        },
      },
    ])
  }
}

function requireTerminalStatus(
  status: WorkflowRunStatus,
  context: string
): TerminalWorkflowRunStatus {
  if (status === "queued" || status === "running" || status === "waiting") {
    throw new Error(`[SixbWorkflowWorker] ${context} is not terminal.`)
  }

  return status
}
