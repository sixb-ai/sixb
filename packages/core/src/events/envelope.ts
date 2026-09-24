import type { KernelOperation, TrustedPrimitiveKind } from "../execution/types"
import type { JsonValue } from "../json"

/**
 * Workload that made an ontology change, copied from its execution.
 *
 * It names what ran; `requestedBy` names on whose behalf. A primitive carries its definition id so
 * a consumer can tell which workflow, sync, or webhook wrote without reading the run. An Agent
 * `runId` is its Agent run, or the step run of a Workflow Agent step.
 */
export type EventExecutor =
  | { readonly type: "request"; readonly requestId: string }
  | {
      readonly type: "primitive"
      readonly kind: TrustedPrimitiveKind
      readonly id: string
      readonly runId: string
    }
  | { readonly type: "agent"; readonly runId: string }
  | { readonly type: "kernel"; readonly operation: KernelOperation }

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
  origin?: EventOrigin
  metadata?: Record<string, JsonValue>
}
