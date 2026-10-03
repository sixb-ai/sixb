import { compareStrings, type JsonValue } from "../json"
import type { ExecutionRecord } from "../storage/executions/types"
import type {
  EventExecutor,
  OntologyMaterializationEvent,
  OntologyMaterializationEventAttribution,
  OntologyMaterializationEventCommit,
  OntologyMaterializationEventDraft,
} from "./events"
import type { OntologyMaterializationPropertyChangeMap } from "./model"

/** Where an event sits in its commit: its id and its ordinal. */
export interface OntologyMaterializationEventSequence {
  readonly id: string
  readonly commitOrdinal: number
}

/**
 * The event consumers receive, rebuilt from the draft storage keeps, the commit it belongs to and
 * the execution that commit ran under. It is the exact event core would have built in one piece,
 * so storing drafts changes nothing a consumer can observe.
 */
export function materializationEvent(
  draft: OntologyMaterializationEventDraft,
  sequence: OntologyMaterializationEventSequence,
  commit: OntologyMaterializationEventCommit,
  attribution: OntologyMaterializationEventAttribution
): OntologyMaterializationEvent {
  const context = {
    id: sequence.id,
    schemaVersion: 1 as const,
    projectId: commit.projectId,
    occurredAt: commit.committedAt,
    correlationId: attribution.correlationId,
    origin: structuredClone(commit.origin),
    ...(attribution.requestedBy === undefined
      ? {}
      : { requestedBy: { ...attribution.requestedBy } }),
    executor: structuredClone(attribution.executor),
    commitId: commit.id,
    commitOrdinal: sequence.commitOrdinal,
  }
  switch (draft.type) {
    case "object.created":
      return {
        ...context,
        type: draft.type,
        topic: "objects",
        partitionKey: `${draft.payload.objectTypeId}:${draft.payload.primaryId}`,
        payload: {
          ...draft.payload,
          propertyChanges: createdPropertyChanges(draft.payload.properties),
        },
      }
    case "object.updated":
      return {
        ...context,
        type: draft.type,
        topic: "objects",
        partitionKey: `${draft.payload.objectTypeId}:${draft.payload.primaryId}`,
        payload: draft.payload,
      }
    case "object.deleted":
      return {
        ...context,
        type: draft.type,
        topic: "objects",
        partitionKey: `${draft.payload.objectTypeId}:${draft.payload.primaryId}`,
        payload: draft.payload,
      }
    case "link.created":
      return {
        ...context,
        type: draft.type,
        topic: "links",
        partitionKey: `${draft.payload.sourceTypeId}:${draft.payload.sourceId}:${draft.payload.linkId}`,
        payload: {
          ...draft.payload,
          propertyChanges: createdPropertyChanges(draft.payload.properties ?? {}),
        },
      }
    case "link.updated":
      return {
        ...context,
        type: draft.type,
        topic: "links",
        partitionKey: `${draft.payload.sourceTypeId}:${draft.payload.sourceId}:${draft.payload.linkId}`,
        payload: draft.payload,
      }
    case "link.deleted":
      return {
        ...context,
        type: draft.type,
        topic: "links",
        partitionKey: `${draft.payload.sourceTypeId}:${draft.payload.sourceId}:${draft.payload.linkId}`,
        payload: draft.payload,
      }
    case "telemetry.appended":
      return {
        ...context,
        type: draft.type,
        topic: "telemetry",
        partitionKey: `${draft.payload.objectTypeId}:${draft.payload.objectId}:${draft.payload.propertyId}`,
        payload: draft.payload,
      }
  }
}

/**
 * What the events of a commit say about who asked for it and what wrote it, read from the
 * execution it ran under. A primitive's id lives in the execution's authority, the only place the
 * durable record keeps it.
 */
export function eventAttribution(
  execution: Pick<
    ExecutionRecord,
    "id" | "correlationId" | "requestedBy" | "executor" | "authorizationRef"
  >
): OntologyMaterializationEventAttribution {
  const attribution = {
    correlationId: execution.correlationId,
    executor: eventExecutor(execution),
  }
  if (execution.requestedBy === undefined) return attribution
  const { type, id } = execution.requestedBy
  return { ...attribution, requestedBy: { type, id } }
}

function eventExecutor(
  execution: Pick<ExecutionRecord, "id" | "executor" | "authorizationRef">
): EventExecutor {
  const { executor, authorizationRef } = execution
  switch (executor.type) {
    case "request":
      return { type: "request", requestId: executor.requestId }
    case "agent":
      return { type: "agent", runId: executor.runId }
    case "kernel":
      return { type: "kernel", operation: structuredClone(executor.operation) }
    case "primitive":
      if (
        authorizationRef.type !== "trustedPrimitive" ||
        authorizationRef.primitive.kind !== executor.kind ||
        authorizationRef.primitive.runId !== executor.runId
      ) {
        throw new Error(
          `[Sixb] Execution '${execution.id}' runs a primitive without that primitive's authority.`
        )
      }
      return {
        type: "primitive",
        kind: executor.kind,
        id: authorizationRef.primitive.id,
        runId: executor.runId,
      }
  }
}

/** A creation changes every property it sets, from nothing to its value, in key order. */
function createdPropertyChanges(
  properties: Readonly<Record<string, JsonValue>>
): OntologyMaterializationPropertyChangeMap {
  const changes: Record<string, { readonly operation: "created"; readonly after: JsonValue }> = {}
  for (const id of Object.keys(properties).sort(compareStrings)) {
    changes[id] = { operation: "created", after: properties[id] as JsonValue }
  }
  return changes
}
