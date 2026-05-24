import type { EventEnvelope } from "../envelope"

export interface WorkflowRunQueuedEvent extends EventEnvelope {
  type: "workflow.run.queued"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    queuedAt: string
    jobId?: string
    source?: {
      type: "manual" | "schedule" | "event"
      id?: string
    }
  }
}

export interface WorkflowRunStartedEvent extends EventEnvelope {
  type: "workflow.run.started"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    startedAt: string
  }
}

export interface WorkflowRunNodeStartedEvent extends EventEnvelope {
  type: "workflow.run.node.started"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    nodeIndex: number
    totalNodes: number
    nodeType: "step" | "action"
    nodeId: string
    nodeKey: string
    startedAt: string
  }
}

export interface WorkflowRunNodeFinishedEvent extends EventEnvelope {
  type: "workflow.run.node.finished"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    nodeIndex: number
    totalNodes: number
    nodeType: "step" | "action"
    nodeId: string
    nodeKey: string
    status: "succeeded" | "failed" | "cancelled"
    finishedAt: string
    error?: string
  }
}

export interface WorkflowRunFinishedEvent extends EventEnvelope {
  type: "workflow.run.finished"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    status: "succeeded" | "failed" | "cancelled"
    finishedAt: string
    error?: string
  }
}

export type WorkflowEvent =
  | WorkflowRunQueuedEvent
  | WorkflowRunStartedEvent
  | WorkflowRunNodeStartedEvent
  | WorkflowRunNodeFinishedEvent
  | WorkflowRunFinishedEvent
