import { clearedPropertyChanges, diffPropertyChanges } from "./property-changes"
import type { DomainEventDraft, EventOrigin, PropertyChangeMap } from "./types"

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

export function buildObjectUpsertEvent(
  input: ObjectUpsertEventInput
): Extract<DomainEventDraft, { type: "object.created" | "object.updated" }> {
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
): Extract<DomainEventDraft, { type: "object.deleted" }> {
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
): Extract<DomainEventDraft, { type: "link.created" | "link.updated" }> {
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
): Extract<DomainEventDraft, { type: "link.deleted" }> {
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
): Pick<DomainEventDraft, "idempotencyKey" | "origin"> {
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
  // Idempotency keys are compared as opaque strings. Delimiter joining is ambiguous when IDs
  // contain that delimiter: ["a", "b:c"] and ["a:b", "c"] both become "a:b:c". JSON preserves
  // each field's boundary, so different links cannot accidentally produce the same key.
  return JSON.stringify([
    input.sourceTypeId,
    input.sourceId,
    input.linkId,
    input.targetTypeId,
    input.targetId,
  ])
}
