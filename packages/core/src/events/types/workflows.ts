import type { SixbFailure } from "../../errors/types"
import type { WorkflowRunFailureCode } from "../../storage/workflow-runs/types"
import type { WorkflowRunSource } from "../../workflows/types"
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
    source?: WorkflowRunSource
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
    nodeType: "step" | "action" | "intervention" | "agent"
    nodeId: string
    nodeKey: string
    startedAt: string
  }
}

export interface WorkflowRunWaitingEvent extends EventEnvelope {
  type: "workflow.run.waiting"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    waitingAt: string
  }
}

export interface WorkflowRunNodeWaitingEvent extends EventEnvelope {
  type: "workflow.run.node.waiting"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    nodeIndex: number
    totalNodes: number
    nodeType: "intervention" | "agent"
    nodeId: string
    nodeKey: string
    waitingAt: string
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
    nodeType: "step" | "action" | "intervention" | "agent"
    nodeId: string
    nodeKey: string
    status: "succeeded" | "failed" | "cancelled"
    finishedAt: string
    error?: SixbFailure<WorkflowRunFailureCode>
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
    error?: SixbFailure<WorkflowRunFailureCode>
  }
}

export interface WorkflowInterventionRequestedEvent extends EventEnvelope {
  type: "workflow.intervention.requested"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    interventionId: string
    pendingInterventionId: string
    requestedAt: string
  }
}

export interface WorkflowInterventionSubmittedEvent extends EventEnvelope {
  type: "workflow.intervention.submitted"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    interventionId: string
    pendingInterventionId: string
    submittedAt: string
  }
}

export interface WorkflowInterventionCancelledEvent extends EventEnvelope {
  type: "workflow.intervention.cancelled"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    interventionId: string
    pendingInterventionId: string
    cancelledAt: string
  }
}

export interface WorkflowInterventionExpiredEvent extends EventEnvelope {
  type: "workflow.intervention.expired"
  topic: "workflows"
  partitionKey: string
  payload: {
    workflowId: string
    runId: string
    nodeRunId: string
    interventionId: string
    pendingInterventionId: string
    expiredAt: string
  }
}

export type WorkflowEvent =
  | WorkflowRunQueuedEvent
  | WorkflowRunStartedEvent
  | WorkflowRunNodeStartedEvent
  | WorkflowRunWaitingEvent
  | WorkflowRunNodeWaitingEvent
  | WorkflowRunNodeFinishedEvent
  | WorkflowRunFinishedEvent
  | WorkflowInterventionRequestedEvent
  | WorkflowInterventionSubmittedEvent
  | WorkflowInterventionCancelledEvent
  | WorkflowInterventionExpiredEvent
