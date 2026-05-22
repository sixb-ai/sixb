import type { EventEnvelope } from "../envelope"

export interface ActionRequestedEvent extends EventEnvelope {
  type: "action.requested"
  topic: "actions"
  partitionKey: string
  payload: {
    objectTypeId: string
    primaryId: string
    actionId: string
    params: Record<string, unknown>
    runId: string
  }
}

export interface ActionCompletedEvent extends EventEnvelope {
  type: "action.completed"
  topic: "actions"
  partitionKey: string
  payload: {
    actionId: string
    runId: string
    objectTypeId: string
    primaryId: string
    finishedAt: string
  }
}

export interface ActionFailedEvent extends EventEnvelope {
  type: "action.failed"
  topic: "actions"
  partitionKey: string
  payload: {
    actionId: string
    runId: string
    objectTypeId: string
    primaryId: string
    error: {
      name?: string
      message: string
      phase?: "handler" | "cancelled"
    }
    finishedAt: string
  }
}

export type ActionEvent = ActionRequestedEvent | ActionCompletedEvent | ActionFailedEvent
