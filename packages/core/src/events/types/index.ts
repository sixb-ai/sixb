import type { JsonValue } from "../../json"
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

export type { EventActor, EventEnvelope } from "../envelope"
export type {
  ActionCompletedEvent,
  ActionEvent,
  ActionFailedEvent,
  ActionRequestedEvent,
} from "./actions"
export type { DatasetEvent, DatasetVersionCommittedEvent } from "./datasets"
export type { LinkEvent, LinkRemovedEvent, LinkUpsertedEvent } from "./links"
export type { ObjectEvent, ObjectUpsertedEvent } from "./objects"
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
  WorkflowRunFinishedEvent,
  WorkflowRunNodeFinishedEvent,
  WorkflowRunNodeStartedEvent,
  WorkflowRunQueuedEvent,
  WorkflowRunStartedEvent,
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

export type NewDomainEvent = {
  [K in DomainEvent["type"]]: {
    type: K
    payload: Extract<DomainEvent, { type: K }>["payload"]
    occurredAt?: string
    metadata?: Record<string, JsonValue>
    idempotencyKey?: string
  }
}[DomainEvent["type"]]

export type StoredObjectUpsertedEvent = Extract<StoredDomainEvent, { type: "object.upserted" }>
export type StoredTelemetryAppendedEvent = Extract<
  StoredDomainEvent,
  { type: "telemetry.appended" }
>
export type StoredLinkUpsertedEvent = Extract<StoredDomainEvent, { type: "link.upserted" }>
export type StoredLinkRemovedEvent = Extract<StoredDomainEvent, { type: "link.removed" }>
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
export type StoredWorkflowRunNodeFinishedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.node.finished" }
>
export type StoredWorkflowRunFinishedEvent = Extract<
  StoredDomainEvent,
  { type: "workflow.run.finished" }
>
export type StoredDatasetVersionCommittedEvent = Extract<
  StoredDomainEvent,
  { type: "dataset.version.committed" }
>
