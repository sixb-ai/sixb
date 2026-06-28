import type { DomainEvent } from "@sixb/core"

type StoredEvent<TEvent extends DomainEvent> = TEvent extends DomainEvent
  ? TEvent & { readonly cursor: string }
  : never

export type SixbEvent = StoredEvent<DomainEvent>
export type SixbEventTopic = SixbEvent["topic"]
export type SixbEventType = SixbEvent["type"]
export type SixbEventOfType<TType extends SixbEventType> = DomainEvent extends infer TEvent
  ? TEvent extends DomainEvent
    ? TEvent["type"] extends TType
      ? StoredEvent<TEvent>
      : never
    : never
  : never
export type SixbEventOfTopic<TTopic extends SixbEventTopic> = DomainEvent extends infer TEvent
  ? TEvent extends DomainEvent
    ? TEvent["topic"] extends TTopic
      ? StoredEvent<TEvent>
      : never
    : never
  : never
export function isSixbEvent(value: unknown): value is SixbEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.cursor === "string" &&
    typeof value.projectId === "string" &&
    typeof value.occurredAt === "string" &&
    typeof value.type === "string" &&
    typeof value.topic === "string" &&
    typeof value.partitionKey === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// The fluent builder, its React-free transport, and the shared telemetry model.
export * from "./events-builder"
export * from "./events-transport"
export * from "./telemetry-events"
