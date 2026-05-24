import type {
  EventsRuntime,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@pario/core"
import type { WorkflowNodeLifecycleContext, WorkflowRunObserver } from "./types"

type TerminalWorkflowRunStatus = Exclude<WorkflowRunStatus, "queued" | "running">

export class EventsRuntimeWorkflowRunObserver implements WorkflowRunObserver {
  constructor(private readonly events: EventsRuntime) {}

  async onRunStarted(run: WorkflowRunRecord): Promise<void> {
    await this.events.append({
      events: [
        {
          type: "workflow.run.started",
          payload: {
            workflowId: run.workflowId,
            runId: run.id,
            startedAt: run.startedAt.toISOString(),
          },
        },
      ],
    })
  }

  async onNodeStarted(
    node: WorkflowNodeRunRecord,
    context: WorkflowNodeLifecycleContext
  ): Promise<void> {
    await this.events.append({
      events: [
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
      ],
    })
  }

  async onNodeFinished(
    node: WorkflowNodeRunRecord,
    context: WorkflowNodeLifecycleContext
  ): Promise<void> {
    if (!node.finishedAt) {
      throw new Error(`[ParioWorkflowWorker] Workflow node run '${node.id}' has no finishedAt.`)
    }

    await this.events.append({
      events: [
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
            ...(node.error ? { error: node.error } : {}),
          },
        },
      ],
    })
  }

  async onRunFinished(run: WorkflowRunRecord): Promise<void> {
    if (!run.finishedAt) {
      throw new Error(`[ParioWorkflowWorker] Workflow run '${run.id}' has no finishedAt.`)
    }

    await this.events.append({
      events: [
        {
          type: "workflow.run.finished",
          payload: {
            workflowId: run.workflowId,
            runId: run.id,
            status: requireTerminalStatus(run.status, `Workflow run '${run.id}'`),
            finishedAt: run.finishedAt.toISOString(),
            ...(run.error ? { error: run.error } : {}),
          },
        },
      ],
    })
  }
}

function requireTerminalStatus(
  status: WorkflowRunStatus,
  context: string
): TerminalWorkflowRunStatus {
  if (status === "queued" || status === "running") {
    throw new Error(`[ParioWorkflowWorker] ${context} is not terminal.`)
  }

  return status
}

export async function emitWorkflowRunFinished(
  events: EventsRuntime,
  job: {
    readonly id: string
    readonly workflowId: string
    readonly status: TerminalWorkflowRunStatus
    readonly finishedAt?: string
    readonly error?: string
  }
): Promise<void> {
  try {
    await events.append({
      events: [
        {
          type: "workflow.run.finished",
          payload: {
            workflowId: job.workflowId,
            runId: job.id,
            status: job.status,
            finishedAt: job.finishedAt ?? new Date().toISOString(),
            ...(job.error ? { error: job.error } : {}),
          },
        },
      ],
    })
  } catch (error) {
    console.error("[ParioWorkflowWorker] Failed to emit workflow.run.finished:", error)
  }
}
