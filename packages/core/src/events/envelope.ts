import type { JsonValue } from "../json"

export interface EventActor {
  type: "user" | "service" | "system"
  id: string
}

export type EventOrigin = {
  kind: "action"
  actionId: string
  runId: string
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
  origin?: EventOrigin
  metadata?: Record<string, JsonValue>
}
