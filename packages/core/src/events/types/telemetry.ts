import type { EventEnvelope } from "../envelope"

export interface TelemetryAppendedEvent extends EventEnvelope {
  type: "telemetry.appended"
  topic: "telemetry"
  partitionKey: string
  payload: {
    objectTypeId: string
    objectId: string
    propertyId: string
    value: unknown
    unit?: string
    at: string
  }
}

export type TelemetryEvent = TelemetryAppendedEvent
