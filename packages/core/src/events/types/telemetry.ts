import type { EventEnvelope } from "../envelope"

export interface TelemetryAppendedEventPayload<TValue = unknown> {
  objectTypeId: string
  objectId: string
  propertyId: string
  value: TValue
  unit?: string
  at: string
}

export interface TelemetryAppendedEvent extends EventEnvelope {
  type: "telemetry.appended"
  topic: "telemetry"
  partitionKey: string
  payload: TelemetryAppendedEventPayload
}

export type TelemetryEvent = TelemetryAppendedEvent
