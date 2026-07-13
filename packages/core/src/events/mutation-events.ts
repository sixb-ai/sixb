import type { EditCommitPlan } from "../edits"
import { clearedPropertyChanges, diffPropertyChanges } from "./property-changes"
import type { EventDraft, EventOrigin, PropertyChangeMap } from "./types"

type ObjectUpsertOperation = "create" | "update"
type LinkUpsertOperation = "create" | "update"

export interface ObjectUpsertEventInput {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly operation: ObjectUpsertOperation
  readonly properties: Record<string, unknown>
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface ObjectDeletedEventInput {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface LinkUpsertEventInput {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly operation: LinkUpsertOperation
  readonly properties?: Record<string, unknown>
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface LinkDeletedEventInput {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly previousProperties?: Record<string, unknown>
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export interface EditCommitPlanEventsInput {
  readonly plan: EditCommitPlan
  readonly idempotencyKeyPrefix?: string
  readonly origin?: EventOrigin
}

export function buildEditCommitPlanEvents(input: EditCommitPlanEventsInput): readonly EventDraft[] {
  const events: EventDraft[] = []

  for (const objectDelete of input.plan.objects.deletes) {
    events.push(
      buildObjectDeletedEvent({
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
      buildObjectUpsertEvent({
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
      buildLinkDeletedEvent({
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
      buildLinkUpsertEvent({
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

export function buildObjectUpsertEvent(
  input: ObjectUpsertEventInput
): Extract<EventDraft, { type: "object.created" | "object.updated" }> {
  const payload = {
    objectTypeId: input.objectTypeId,
    primaryId: input.primaryId,
    properties: input.properties,
    propertyChanges: diffPropertyChanges(input.previousProperties, input.properties),
  }
  const idempotencyKeyBase = objectEventKey(input.objectTypeId, input.primaryId)
  const eventType = input.operation === "create" ? "object.created" : "object.updated"

  return {
    type: eventType,
    payload,
    ...eventOptions(input, `${eventType}:${idempotencyKeyBase}`),
  }
}

export function buildObjectDeletedEvent(
  input: ObjectDeletedEventInput
): Extract<EventDraft, { type: "object.deleted" }> {
  const payload = {
    objectTypeId: input.objectTypeId,
    primaryId: input.primaryId,
    propertyChanges: clearedPropertyChanges(input.previousProperties),
  }
  const idempotencyKeyBase = objectEventKey(input.objectTypeId, input.primaryId)

  return {
    type: "object.deleted",
    payload,
    ...eventOptions(input, `object.deleted:${idempotencyKeyBase}`),
  }
}

export function buildLinkUpsertEvent(
  input: LinkUpsertEventInput
): Extract<EventDraft, { type: "link.created" | "link.updated" }> {
  const payload = {
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    linkId: input.linkId,
    targetTypeId: input.targetTypeId,
    targetId: input.targetId,
    ...(input.properties !== undefined ? { properties: input.properties } : {}),
    propertyChanges: input.properties
      ? diffPropertyChanges(input.previousProperties, input.properties)
      : ({} satisfies PropertyChangeMap),
  }
  const idempotencyKeyBase = linkEventKey(input)
  const eventType = input.operation === "create" ? "link.created" : "link.updated"

  return {
    type: eventType,
    payload,
    ...eventOptions(input, `${eventType}:${idempotencyKeyBase}`),
  }
}

export function buildLinkDeletedEvent(
  input: LinkDeletedEventInput
): Extract<EventDraft, { type: "link.deleted" }> {
  const payload = {
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    linkId: input.linkId,
    targetTypeId: input.targetTypeId,
    targetId: input.targetId,
  }
  const idempotencyKeyBase = linkEventKey(input)

  return {
    type: "link.deleted",
    payload: {
      ...payload,
      propertyChanges: clearedPropertyChanges(input.previousProperties),
    },
    ...eventOptions(input, `link.deleted:${idempotencyKeyBase}`),
  }
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
