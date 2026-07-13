import type { JsonValue } from "../../json"
import type { EventOrigin } from "../envelope"
import type { ActionEvent } from "./actions"
import type { DatasetEvent } from "./datasets"
import type { LinkEvent } from "./links"
import type { ObjectEvent } from "./objects"
import type { PipelineEvent } from "./pipelines"
import type { RuleEvent } from "./rules"
import type { ScheduleEvent } from "./schedules"
import type { SyncEvent } from "./syncs"
import type { TelemetryEvent } from "./telemetry"
import type { WorkflowEvent } from "./workflows"

export type { EventActor, EventEnvelope, EventOrigin } from "../envelope"
export type {
  PropertyChange,
  PropertyChangeMap,
  PropertyChangeOperation,
} from "../property-changes"
export type {
  ActionCompletedEvent,
  ActionEvent,
  ActionFailedEvent,
  ActionRequestedEvent,
} from "./actions"
export type { DatasetEvent, DatasetVersionCommittedEvent } from "./datasets"
export type {
  LinkCreatedEvent,
  LinkDeletedEvent,
  LinkEvent,
  LinkUpdatedEvent,
} from "./links"
export type {
  ObjectCreatedEvent,
  ObjectDeletedEvent,
  ObjectEvent,
  ObjectUpdatedEvent,
} from "./objects"
export type {
  PipelineEvent,
  PipelineRunFinishedEvent,
  PipelineRunStartedEvent,
  PipelineRunStepFinishedEvent,
  PipelineRunStepStartedEvent,
} from "./pipelines"
export type {
  RuleEvent,
  RuleEventSubject,
  RuleResolvedEvent,
  RuleTriggeredEvent,
} from "./rules"
export type { ScheduleEvent, ScheduleTriggeredEvent } from "./schedules"
export type { SyncEvent, SyncRunFinishedEvent, SyncRunStartedEvent } from "./syncs"
export type { TelemetryAppendedEvent, TelemetryEvent } from "./telemetry"
export type {
  WorkflowEvent,
  WorkflowInterventionCancelledEvent,
  WorkflowInterventionExpiredEvent,
  WorkflowInterventionRequestedEvent,
  WorkflowInterventionSubmittedEvent,
  WorkflowRunFinishedEvent,
  WorkflowRunNodeFinishedEvent,
  WorkflowRunNodeStartedEvent,
  WorkflowRunNodeWaitingEvent,
  WorkflowRunQueuedEvent,
  WorkflowRunStartedEvent,
  WorkflowRunWaitingEvent,
} from "./workflows"

export type DomainEvent =
  | ObjectEvent
  | TelemetryEvent
  | LinkEvent
  | ActionEvent
  | ScheduleEvent
  | RuleEvent
  | SyncEvent
  | PipelineEvent
  | WorkflowEvent
  | DatasetEvent

export type StoredDomainEvent = DomainEvent & {
  cursor: string
}

export type EventDraft = {
  [K in DomainEvent["type"]]: {
    type: K
    payload: Extract<DomainEvent, { type: K }>["payload"]
    occurredAt?: string
    origin?: EventOrigin
    metadata?: Record<string, JsonValue>
    idempotencyKey?: string
  }
}[DomainEvent["type"]]

export type StoredObjectCreatedEvent = Extract<StoredDomainEvent, { type: "object.created" }>
export type StoredObjectUpdatedEvent = Extract<StoredDomainEvent, { type: "object.updated" }>
export type StoredObjectMutationEvent = StoredObjectCreatedEvent | StoredObjectUpdatedEvent
export type StoredObjectDeletedEvent = Extract<StoredDomainEvent, { type: "object.deleted" }>
export type StoredTelemetryAppendedEvent = Extract<
  StoredDomainEvent,
  { type: "telemetry.appended" }
>
export type StoredLinkCreatedEvent = Extract<StoredDomainEvent, { type: "link.created" }>
export type StoredLinkUpdatedEvent = Extract<StoredDomainEvent, { type: "link.updated" }>
export type StoredLinkMutationEvent = StoredLinkCreatedEvent | StoredLinkUpdatedEvent
export type StoredLinkDeletedEvent = Extract<StoredDomainEvent, { type: "link.deleted" }>
export type StoredActionRequestedEvent = Extract<StoredDomainEvent, { type: "action.requested" }>
export type StoredActionCompletedEvent = Extract<StoredDomainEvent, { type: "action.completed" }>
export type StoredActionFailedEvent = Extract<StoredDomainEvent, { type: "action.failed" }>
export type StoredScheduleTriggeredEvent = Extract<
  StoredDomainEvent,
  { type: "schedule.triggered" }
>
export type StoredRuleTriggeredEvent = Extract<StoredDomainEvent, { type: "rule.triggered" }>
export type StoredRuleResolvedEvent = Extract<StoredDomainEvent, { type: "rule.resolved" }>
export type StoredSyncRunStartedEvent = Extract<StoredDomainEvent, { type: "sync.run.started" }>
export type StoredSyncRunFinishedEvent = Extract<StoredDomainEvent, { type: "sync.run.finished" }>
export type StoredPipelineRunStartedEvent = Extract<
  StoredDomainEvent,
  { type: "pipeline.run.started" }
>
export type StoredPipelineRunStepStartedEvent = Extract<
  StoredDomainEvent,
  { type: "pipeline.run.step.started" }
>
export type StoredPipelineRunStepFinishedEvent = Extract<
  StoredDomainEvent,
  { type: "pipeline.run.step.finished" }
>
export type StoredPipelineRunFinishedEvent = Extract<
  StoredDomainEvent,
  { type: "pipeline.run.finished" }
>
export type StoredWorkflowRunQueuedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.queued" }
>
export type StoredWorkflowRunStartedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.started" }
>
export type StoredWorkflowRunNodeStartedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.node.started" }
>
export type StoredWorkflowRunWaitingEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.waiting" }
>
export type StoredWorkflowRunNodeWaitingEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.node.waiting" }
>
export type StoredWorkflowRunNodeFinishedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.node.finished" }
>
export type StoredWorkflowRunFinishedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.finished" }
>
export type StoredWorkflowInterventionRequestedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.intervention.requested" }
>
export type StoredWorkflowInterventionSubmittedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.intervention.submitted" }
>
export type StoredWorkflowInterventionCancelledEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.intervention.cancelled" }
>
export type StoredWorkflowInterventionExpiredEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.intervention.expired" }
>
export type StoredDatasetVersionCommittedEvent = Extract<
  StoredDomainEvent,
  { type: "dataset.version.committed" }
>
