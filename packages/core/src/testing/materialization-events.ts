import type {
  StoredLinkDeletedEvent,
  StoredLinkMutationEvent,
  StoredObjectDeletedEvent,
  StoredObjectMutationEvent,
  StoredTelemetryAppendedEvent,
} from "../events"
import type { JsonValue } from "../json"

interface StoredFactInput {
  readonly projectId: string
  readonly id?: string
  readonly cursor?: string
  readonly occurredAt?: string
  readonly requestId?: string
  readonly commitId?: string
  readonly commitOrdinal?: number
}

export function createStoredObjectMutationEvent(
  input: StoredFactInput & {
    readonly type?: "object.created" | "object.updated"
    readonly objectTypeId: string
    readonly primaryId: string
    readonly properties: Readonly<Record<string, JsonValue>>
    readonly propertyChanges?: StoredObjectMutationEvent["payload"]["propertyChanges"]
  }
): StoredObjectMutationEvent {
  return {
    ...storedFactBase(input),
    type: input.type ?? "object.created",
    topic: "objects",
    partitionKey: `${input.objectTypeId}:${input.primaryId}`,
    payload: {
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
      properties: input.properties,
      propertyChanges: input.propertyChanges ?? {},
    },
  }
}

export function createStoredObjectDeletedEvent(
  input: StoredFactInput & {
    readonly objectTypeId: string
    readonly primaryId: string
    readonly propertyChanges?: StoredObjectDeletedEvent["payload"]["propertyChanges"]
  }
): StoredObjectDeletedEvent {
  return {
    ...storedFactBase(input),
    type: "object.deleted",
    topic: "objects",
    partitionKey: `${input.objectTypeId}:${input.primaryId}`,
    payload: {
      objectTypeId: input.objectTypeId,
      primaryId: input.primaryId,
      propertyChanges: input.propertyChanges ?? {},
    },
  }
}

export function createStoredLinkMutationEvent(
  input: StoredFactInput & {
    readonly type?: "link.created" | "link.updated"
    readonly sourceTypeId: string
    readonly sourceId: string
    readonly linkId: string
    readonly targetTypeId: string
    readonly targetId: string
    readonly properties?: Readonly<Record<string, JsonValue>>
    readonly propertyChanges?: StoredLinkMutationEvent["payload"]["propertyChanges"]
  }
): StoredLinkMutationEvent {
  return {
    ...storedFactBase(input),
    type: input.type ?? "link.created",
    topic: "links",
    partitionKey: `${input.sourceTypeId}:${input.sourceId}:${input.linkId}`,
    payload: {
      sourceTypeId: input.sourceTypeId,
      sourceId: input.sourceId,
      linkId: input.linkId,
      targetTypeId: input.targetTypeId,
      targetId: input.targetId,
      ...(input.properties === undefined ? {} : { properties: input.properties }),
      propertyChanges: input.propertyChanges ?? {},
    },
  }
}

export function createStoredLinkDeletedEvent(
  input: StoredFactInput & {
    readonly sourceTypeId: string
    readonly sourceId: string
    readonly linkId: string
    readonly targetTypeId: string
    readonly targetId: string
    readonly propertyChanges?: StoredLinkDeletedEvent["payload"]["propertyChanges"]
  }
): StoredLinkDeletedEvent {
  return {
    ...storedFactBase(input),
    type: "link.deleted",
    topic: "links",
    partitionKey: `${input.sourceTypeId}:${input.sourceId}:${input.linkId}`,
    payload: {
      sourceTypeId: input.sourceTypeId,
      sourceId: input.sourceId,
      linkId: input.linkId,
      targetTypeId: input.targetTypeId,
      targetId: input.targetId,
      propertyChanges: input.propertyChanges ?? {},
    },
  }
}

export function createStoredTelemetryAppendedEvent(
  input: StoredFactInput & {
    readonly objectTypeId: string
    readonly objectId: string
    readonly propertyId: string
    readonly value: JsonValue
    readonly unit?: string
    readonly at: string
  }
): StoredTelemetryAppendedEvent {
  return {
    ...storedFactBase(input),
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: `${input.objectTypeId}:${input.objectId}:${input.propertyId}`,
    payload: {
      objectTypeId: input.objectTypeId,
      objectId: input.objectId,
      propertyId: input.propertyId,
      value: input.value,
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      at: input.at,
    },
  }
}

function storedFactBase(input: StoredFactInput) {
  const id = input.id ?? `evt-${crypto.randomUUID()}`
  return {
    id,
    cursor: input.cursor ?? id,
    schemaVersion: 1 as const,
    projectId: input.projectId,
    occurredAt: input.occurredAt ?? "2026-01-01T00:00:00.000Z",
    origin: {
      kind: "runtime" as const,
      requestId: input.requestId ?? `request:${id}`,
    },
    commitId: input.commitId ?? `commit:${id}`,
    commitOrdinal: input.commitOrdinal ?? 0,
  }
}
