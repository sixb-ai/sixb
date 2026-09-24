import { randomUUID } from "node:crypto"
import { resolveEventStorage } from "./definitions"
import type { EventDraft, StoredAuthorableEvent } from "./types/index"

export function toStoredEvent(params: {
  projectId: string
  correlationId?: string
  causationId?: string
  event: EventDraft
  cursor: string
}): StoredAuthorableEvent {
  const base = {
    id: randomUUID(),
    schemaVersion: 1 as const,
    projectId: params.projectId,
    occurredAt: params.event.occurredAt ?? new Date().toISOString(),
    correlationId: params.correlationId,
    causationId: params.causationId,
    idempotencyKey: params.event.idempotencyKey,
    origin: params.event.origin,
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
  } as StoredAuthorableEvent
}
