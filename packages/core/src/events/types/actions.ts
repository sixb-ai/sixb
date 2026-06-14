import type { ActionSubject } from "../../actions"
import type { ActionRunFailure } from "../../storage"
import type { EventEnvelope } from "../envelope"

export interface ActionRequestedEvent extends EventEnvelope {
  type: "action.requested"
  topic: "actions"
  partitionKey: string
  payload: {
    actionId: string
    subject: ActionSubject
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
    subject: ActionSubject
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
    subject: ActionSubject
    error: ActionRunFailure
    finishedAt: string
  }
}

export type ActionEvent = ActionRequestedEvent | ActionCompletedEvent | ActionFailedEvent
