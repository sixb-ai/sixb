import type { JsonValue } from "../json"

export interface EventActor {
  type: "user" | "service" | "system"
  id: string
}

export interface EventEnvelope {
  id: string
  schemaVersion: 1
  projectId: string
  occurredAt: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
  actor?: EventActor
  metadata?: Record<string, JsonValue>
}
