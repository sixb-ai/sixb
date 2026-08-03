import { SixbError } from "../errors"
import type { ActionEvent } from "./types/actions"
import type { DatasetEvent } from "./types/datasets"
import type { DomainEvent, DomainEventDraft } from "./types/index"
import type { LinkEvent } from "./types/links"
import type { ObjectEvent } from "./types/objects"
import type { PipelineEvent } from "./types/pipelines"
import type { RuleEvent } from "./types/rules"
import type { ScheduleEvent } from "./types/schedules"
import type { SyncEvent } from "./types/syncs"
import type { TelemetryEvent } from "./types/telemetry"
import type { WorkflowEvent } from "./types/workflows"

export type EventDefinition<Event extends DomainEvent = DomainEvent> = {
  readonly topic: Event["topic"]
  readonly partitionKey: (payload: Event["payload"]) => string
}

export type EventDefinitionGroup<Event extends DomainEvent> = {
  readonly [Type in Event["type"]]: EventDefinition<Extract<Event, { type: Type }>>
}

export type EventDefinitionMap = {
  readonly [Type in DomainEvent["type"]]: EventDefinition<Extract<DomainEvent, { type: Type }>>
}

function defineEventGroup<Event extends DomainEvent>(
  definitions: EventDefinitionGroup<Event>
): EventDefinitionGroup<Event> {
  return definitions
}

export const OBJECT_EVENT_DEFINITIONS = defineEventGroup<ObjectEvent>({
  "object.created": {
    topic: "objects",
    partitionKey: (payload) => `${payload.objectTypeId}:${payload.primaryId}`,
  },
  "object.updated": {
    topic: "objects",
    partitionKey: (payload) => `${payload.objectTypeId}:${payload.primaryId}`,
  },
  "object.deleted": {
    topic: "objects",
    partitionKey: (payload) => `${payload.objectTypeId}:${payload.primaryId}`,
  },
})

export const TELEMETRY_EVENT_DEFINITIONS = defineEventGroup<TelemetryEvent>({
  "telemetry.appended": {
    topic: "telemetry",
    partitionKey: (payload) => `${payload.objectTypeId}:${payload.objectId}:${payload.propertyId}`,
  },
})

export const LINK_EVENT_DEFINITIONS = defineEventGroup<LinkEvent>({
  "link.created": {
    topic: "links",
    partitionKey: (payload) => `${payload.sourceTypeId}:${payload.sourceId}:${payload.linkId}`,
  },
  "link.updated": {
    topic: "links",
    partitionKey: (payload) => `${payload.sourceTypeId}:${payload.sourceId}:${payload.linkId}`,
  },
  "link.deleted": {
    topic: "links",
    partitionKey: (payload) => `${payload.sourceTypeId}:${payload.sourceId}:${payload.linkId}`,
  },
})

export const ACTION_EVENT_DEFINITIONS = defineEventGroup<ActionEvent>({
  "action.requested": {
    topic: "actions",
    partitionKey: (payload) => payload.actionId,
  },
  "action.completed": {
    topic: "actions",
    partitionKey: (payload) => payload.actionId,
  },
  "action.failed": {
    topic: "actions",
    partitionKey: (payload) => payload.actionId,
  },
})

export const SCHEDULE_EVENT_DEFINITIONS = defineEventGroup<ScheduleEvent>({
  "schedule.triggered": {
    topic: "schedules",
    partitionKey: (payload) => payload.scheduleId,
  },
})

export const RULE_EVENT_DEFINITIONS = defineEventGroup<RuleEvent>({
  "rule.triggered": {
    topic: "rules",
    partitionKey: (payload) =>
      `${payload.ruleId}:${payload.subject.objectTypeId}:${payload.subject.primaryId}`,
  },
  "rule.resolved": {
    topic: "rules",
    partitionKey: (payload) =>
      `${payload.ruleId}:${payload.subject.objectTypeId}:${payload.subject.primaryId}`,
  },
})

export const SYNC_EVENT_DEFINITIONS = defineEventGroup<SyncEvent>({
  "sync.run.started": {
    topic: "syncs",
    partitionKey: (payload) => `${payload.syncId}:${payload.runId}`,
  },
  "sync.run.finished": {
    topic: "syncs",
    partitionKey: (payload) => `${payload.syncId}:${payload.runId}`,
  },
})

export const PIPELINE_EVENT_DEFINITIONS = defineEventGroup<PipelineEvent>({
  "pipeline.run.started": {
    topic: "pipelines",
    partitionKey: (payload) => `${payload.pipelineId}:${payload.runId}`,
  },
  "pipeline.run.step.started": {
    topic: "pipelines",
    partitionKey: (payload) => `${payload.pipelineId}:${payload.runId}`,
  },
  "pipeline.run.step.finished": {
    topic: "pipelines",
    partitionKey: (payload) => `${payload.pipelineId}:${payload.runId}`,
  },
  "pipeline.run.finished": {
    topic: "pipelines",
    partitionKey: (payload) => `${payload.pipelineId}:${payload.runId}`,
  },
})

export const WORKFLOW_EVENT_DEFINITIONS = defineEventGroup<WorkflowEvent>({
  "workflow.run.queued": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.run.started": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.run.node.started": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.run.waiting": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.run.node.waiting": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.run.node.finished": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.run.finished": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.intervention.requested": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.intervention.submitted": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.intervention.cancelled": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
  "workflow.intervention.expired": {
    topic: "workflows",
    partitionKey: (payload) => `${payload.workflowId}:${payload.runId}`,
  },
})

export const DATASET_EVENT_DEFINITIONS = defineEventGroup<DatasetEvent>({
  "dataset.version.committed": {
    topic: "datasets",
    partitionKey: (payload) => payload.datasetId,
  },
})

export const EVENT_DEFINITIONS = {
  ...OBJECT_EVENT_DEFINITIONS,
  ...TELEMETRY_EVENT_DEFINITIONS,
  ...LINK_EVENT_DEFINITIONS,
  ...ACTION_EVENT_DEFINITIONS,
  ...SCHEDULE_EVENT_DEFINITIONS,
  ...SYNC_EVENT_DEFINITIONS,
  ...PIPELINE_EVENT_DEFINITIONS,
  ...WORKFLOW_EVENT_DEFINITIONS,
  ...DATASET_EVENT_DEFINITIONS,
  ...RULE_EVENT_DEFINITIONS,
} as const satisfies EventDefinitionMap

export const EVENT_TYPES = Object.keys(EVENT_DEFINITIONS) as readonly DomainEvent["type"][]
export const EVENT_TOPICS = [
  ...new Set(
    Object.values(EVENT_DEFINITIONS).map((definition): DomainEvent["topic"] => definition.topic)
  ),
] as readonly DomainEvent["topic"][]

export function isDomainEventType(value: string): value is DomainEvent["type"] {
  return Object.hasOwn(EVENT_DEFINITIONS, value)
}

export function isOntologyFactType(
  value: string
): value is ObjectEvent["type"] | LinkEvent["type"] | TelemetryEvent["type"] {
  return (
    Object.hasOwn(OBJECT_EVENT_DEFINITIONS, value) ||
    Object.hasOwn(LINK_EVENT_DEFINITIONS, value) ||
    Object.hasOwn(TELEMETRY_EVENT_DEFINITIONS, value)
  )
}

export function getEventTopic(type: DomainEvent["type"]): DomainEvent["topic"] {
  return EVENT_DEFINITIONS[type].topic
}

export function resolveEventStorage(event: DomainEventDraft): {
  readonly topic: DomainEvent["topic"]
  readonly partitionKey: string
} {
  const eventType = event.type as string
  if (!isDomainEventType(eventType)) {
    throw new SixbError("runtime.invariant_violated", `Unknown event type: ${eventType}`)
  }

  const definition = EVENT_DEFINITIONS[eventType] as EventDefinition
  return {
    topic: definition.topic,
    partitionKey: definition.partitionKey(event.payload),
  }
}
