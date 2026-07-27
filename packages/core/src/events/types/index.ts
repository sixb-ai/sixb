import type { JsonValue } from "../../json"
import type { OntologyMaterializationEvent } from "../../materialization/events"
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

export type {
  ActionEventOrigin,
  EventActor,
  EventEnvelope,
  EventOrigin,
  ProjectionEventOrigin,
  ProjectionTelemetryEventSource,
  RuntimeMutationEventOrigin,
  TelemetryEventOrigin,
  TelemetryEventSource,
} from "../envelope"
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

export type OntologyDomainEvent = ObjectEvent | LinkEvent | TelemetryEvent
export type AuthorableDomainEvent = Exclude<DomainEvent, OntologyDomainEvent>

export type StoredAuthorableEvent = AuthorableDomainEvent & { readonly cursor: string }
export type StoredOntologyMaterializationEvent = OntologyMaterializationEvent & {
  readonly cursor: string
}
export type StoredDomainEvent = StoredAuthorableEvent | StoredOntologyMaterializationEvent

export type DomainEventDraft = {
  [K in DomainEvent["type"]]: {
    type: K
    payload: Extract<DomainEvent, { type: K }>["payload"]
    occurredAt?: string
    origin?: EventOrigin
    metadata?: Record<string, JsonValue>
    idempotencyKey?: string
  }
}[DomainEvent["type"]]

/** Events callers may author directly. Ontology facts are reserved for the Materializer outbox. */
export type AuthorableEventDraft = Extract<
  DomainEventDraft,
  { readonly type: AuthorableDomainEvent["type"] }
>
export type EventDraft = AuthorableEventDraft

type StoredOntologyEventOf<TType extends OntologyMaterializationEvent["type"]> =
  StoredOntologyMaterializationEvent & { readonly type: TType }

export type StoredObjectCreatedEvent = StoredOntologyEventOf<"object.created">
export type StoredObjectUpdatedEvent = StoredOntologyEventOf<"object.updated">
export type StoredObjectMutationEvent = StoredObjectCreatedEvent | StoredObjectUpdatedEvent
export type StoredObjectDeletedEvent = StoredOntologyEventOf<"object.deleted">
export type StoredTelemetryAppendedEvent = StoredOntologyEventOf<"telemetry.appended">
export type StoredLinkCreatedEvent = StoredOntologyEventOf<"link.created">
export type StoredLinkUpdatedEvent = StoredOntologyEventOf<"link.updated">
export type StoredLinkMutationEvent = StoredLinkCreatedEvent | StoredLinkUpdatedEvent
export type StoredLinkDeletedEvent = StoredOntologyEventOf<"link.deleted">
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
