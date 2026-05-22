import { randomUUID } from "node:crypto"
import { resolveEventStorage } from "./definitions"
import type { EventActor, NewDomainEvent, StoredDomainEvent } from "./types/index"

export function toStoredEvent(params: {
  projectId: string
  actor?: EventActor
  correlationId?: string
  causationId?: string
  event: NewDomainEvent
  cursor: string
}): StoredDomainEvent {
  const base = {
    id: randomUUID(),
    schemaVersion: 1 as const,
    projectId: params.projectId,
    occurredAt: params.event.occurredAt ?? new Date().toISOString(),
    correlationId: params.correlationId,
    causationId: params.causationId,
    idempotencyKey: params.event.idempotencyKey,
    actor: params.actor,
    metadata: params.event.metadata,
    cursor: params.cursor,
  }

  const storage = resolveEventStorage(params.event)
  return {
    ...base,
    type: params.event.type,
    topic: storage.topic,
    partitionKey: storage.partitionKey,
    payload: params.event.payload,
  } as StoredDomainEvent
}
