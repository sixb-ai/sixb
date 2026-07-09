import type { EditCommitPlan } from "../edits"
import {
  clearedPropertyChanges,
  diffPropertyChanges,
  type EventDraft,
  type EventOrigin,
  type PropertyChangeMap,
} from "../events"

type ObjectMutationOperation = "create" | "update"
type LinkMutationOperation = "create" | "update"

export interface ObjectMutationEventInput {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly operation: ObjectMutationOperation
  readonly properties: Record<string, unknown>
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface ObjectDeleteMutationEventInput {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface LinkMutationEventInput {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly operation: LinkMutationOperation
  readonly properties?: Record<string, unknown>
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface LinkRemoveMutationEventInput {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface EditCommitPlanMutationEventsInput {
  readonly plan: EditCommitPlan
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export function buildEditCommitPlanMutationEvents(
  input: EditCommitPlanMutationEventsInput
): readonly EventDraft[] {
  const events: EventDraft[] = []

  for (const objectDelete of input.plan.objects.deletes) {
    events.push(
      ...buildObjectDeletedMutationEvents({
        objectTypeId: objectDelete.objectTypeId,
        primaryId: objectDelete.primaryId,
        previousProperties: objectDelete.previousProperties
          ? { ...objectDelete.previousProperties }
          : undefined,
        idempotencyKeyPrefix: input.idempotencyKeyPrefix,
        origin: input.origin,
      })
    )
  }

  for (const objectUpsert of input.plan.objects.upserts) {
    events.push(
      ...buildObjectUpsertMutationEvents({
        objectTypeId: objectUpsert.objectTypeId,
        primaryId: objectUpsert.primaryId,
        operation: objectUpsert.operation,
        properties: { ...objectUpsert.properties },
        previousProperties: objectUpsert.previousProperties
          ? { ...objectUpsert.previousProperties }
          : undefined,
        idempotencyKeyPrefix: input.idempotencyKeyPrefix,
        origin: input.origin,
      })
    )
  }

  for (const linkDelete of input.plan.links.deletes) {
    events.push(
      ...buildLinkRemovedMutationEvents({
        sourceTypeId: linkDelete.source.objectTypeId,
        sourceId: linkDelete.source.primaryId,
        linkId: linkDelete.linkId,
        targetTypeId: linkDelete.target.objectTypeId,
        targetId: linkDelete.target.primaryId,
        previousProperties: linkDelete.previousProperties
          ? { ...linkDelete.previousProperties }
          : undefined,
        idempotencyKeyPrefix: input.idempotencyKeyPrefix,
        origin: input.origin,
      })
    )
  }

  for (const linkUpsert of input.plan.links.upserts) {
    events.push(
      ...buildLinkUpsertMutationEvents({
        sourceTypeId: linkUpsert.source.objectTypeId,
        sourceId: linkUpsert.source.primaryId,
        linkId: linkUpsert.linkId,
        targetTypeId: linkUpsert.target.objectTypeId,
        targetId: linkUpsert.target.primaryId,
        operation: linkUpsert.operation,
        ...(linkUpsert.properties !== undefined
          ? { properties: { ...linkUpsert.properties } }
          : {}),
        previousProperties: linkUpsert.previousProperties
          ? { ...linkUpsert.previousProperties }
          : undefined,
        idempotencyKeyPrefix: input.idempotencyKeyPrefix,
        origin: input.origin,
      })
    )
  }

  return events
}

export function buildObjectUpsertMutationEvents(
  input: ObjectMutationEventInput
): readonly [EventDraft, EventDraft] {
  const legacyPayload = {
    objectTypeId: input.objectTypeId,
    primaryId: input.primaryId,
    properties: input.properties,
  }
  const idempotencyKeyBase = objectEventKey(input.objectTypeId, input.primaryId)

  const eventType = input.operation === "create" ? "object.created" : "object.updated"

  return [
    {
      type: "object.upserted",
      payload: legacyPayload,
      ...eventOptions(input, `object.upserted:${idempotencyKeyBase}`),
    },
    {
      type: eventType,
      payload: {
        ...legacyPayload,
        propertyChanges: diffPropertyChanges(input.previousProperties, input.properties),
      },
      ...eventOptions(input, `${eventType}:${idempotencyKeyBase}`),
    },
  ]
}

export function buildObjectDeletedMutationEvents(
  input: ObjectDeleteMutationEventInput
): readonly [EventDraft] {
  const payload = {
    objectTypeId: input.objectTypeId,
    primaryId: input.primaryId,
    propertyChanges: clearedPropertyChanges(input.previousProperties),
  }
  const idempotencyKeyBase = objectEventKey(input.objectTypeId, input.primaryId)

  return [
    {
      type: "object.deleted",
      payload,
      ...eventOptions(input, `object.deleted:${idempotencyKeyBase}`),
    },
  ]
}

export function buildLinkUpsertMutationEvents(
  input: LinkMutationEventInput
): readonly [EventDraft, EventDraft] {
  const legacyPayload = {
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    linkId: input.linkId,
    targetTypeId: input.targetTypeId,
    targetId: input.targetId,
    ...(input.properties !== undefined ? { properties: input.properties } : {}),
  }
  const propertyChanges = input.properties
    ? diffPropertyChanges(input.previousProperties, input.properties)
    : ({} satisfies PropertyChangeMap)
  const idempotencyKeyBase = linkEventKey(input)
  const eventType = input.operation === "create" ? "link.created" : "link.updated"

  return [
    {
      type: "link.upserted",
      payload: legacyPayload,
      ...eventOptions(input, `link.upserted:${idempotencyKeyBase}`),
    },
    {
      type: eventType,
      payload: {
        ...legacyPayload,
        propertyChanges,
      },
      ...eventOptions(input, `${eventType}:${idempotencyKeyBase}`),
    },
  ]
}

export function buildLinkRemovedMutationEvents(
  input: LinkRemoveMutationEventInput
): readonly [EventDraft, EventDraft] {
  const payload = {
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    linkId: input.linkId,
    targetTypeId: input.targetTypeId,
    targetId: input.targetId,
  }
  const idempotencyKeyBase = linkEventKey(input)

  return [
    {
      type: "link.removed",
      payload,
      ...eventOptions(input, `link.removed:${idempotencyKeyBase}`),
    },
    {
      type: "link.deleted",
      payload: {
        ...payload,
        propertyChanges: clearedPropertyChanges(input.previousProperties),
      },
      ...eventOptions(input, `link.deleted:${idempotencyKeyBase}`),
    },
  ]
}

function eventOptions(
  input: { readonly idempotencyKeyPrefix?: string; readonly origin?: EventOrigin },
  fallbackKey: string
): Pick<EventDraft, "idempotencyKey" | "origin"> {
  return {
    ...(input.idempotencyKeyPrefix !== undefined
      ? { idempotencyKey: `${input.idempotencyKeyPrefix}:${fallbackKey}` }
      : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
  }
}

function objectEventKey(objectTypeId: string, primaryId: string): string {
  return `${objectTypeId}:${primaryId}`
}

function linkEventKey(input: {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
}): string {
  return `${input.sourceTypeId}:${input.sourceId}:${input.linkId}:${input.targetTypeId}:${input.targetId}`
}
