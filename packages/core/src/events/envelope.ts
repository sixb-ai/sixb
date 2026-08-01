import type { JsonValue } from "../json"

/**
 * Who made a change.
 *
 * The type literals are exactly `Principal["type"]` from `auth/types`, on purpose: an actor *is* a
 * principal recorded on an event, and two spellings of the same concept meant a translation layer
 * between them, which is one more place for the two to drift.
 */
export interface EventActor {
  type: "user" | "serviceAccount" | "system"
  id: string
}

export interface ActionEventOrigin {
  readonly kind: "action"
  readonly actionId: string
  readonly runId: string
}

/** A direct SDK/runtime mutation, outside an Action or Projection. */
export interface RuntimeMutationEventOrigin {
  readonly kind: "runtime"
  readonly requestId: string
}

interface ProjectionEventOriginDetails {
  readonly projectionId: string
  readonly projectionRunId: string
  readonly datasetId: string
  readonly datasetVersionId: string
}

export interface ProjectionEventOrigin extends ProjectionEventOriginDetails {
  readonly kind: "projection"
}

export interface ProjectionTelemetryEventSource extends ProjectionEventOriginDetails {
  readonly kind: "projection"
  readonly batchOrdinal: number
}

export type TelemetryEventSource = RuntimeMutationEventOrigin | ProjectionTelemetryEventSource

export interface TelemetryEventOrigin {
  readonly kind: "telemetry"
  readonly source: TelemetryEventSource
}

/** Public provenance carried by stored events. Ontology facts use the full union. */
export type EventOrigin =
  | ActionEventOrigin
  | RuntimeMutationEventOrigin
  | ProjectionEventOrigin
  | TelemetryEventOrigin

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
