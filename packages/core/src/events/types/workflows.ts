import type { EventEnvelope } from "../envelope"

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
  }
}

export type WorkflowEvent =
  | WorkflowRunStartedEvent
  | WorkflowRunNodeStartedEvent
  | WorkflowRunNodeFinishedEvent
  | WorkflowRunFinishedEvent
