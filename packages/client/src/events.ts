import type { DomainEvent } from "@pario/core"

type StoredEvent<TEvent extends DomainEvent> = TEvent extends DomainEvent
  ? TEvent & { readonly cursor: string }
  : never

export type ParioEvent = StoredEvent<DomainEvent>
export type ParioEventTopic = ParioEvent["topic"]
export type ParioEventType = ParioEvent["type"]
export type ParioEventOfType<TType extends ParioEventType> = DomainEvent extends infer TEvent
  ? TEvent extends DomainEvent
    ? TEvent["type"] extends TType
      ? StoredEvent<TEvent>
      : never
    : never
  : never
export type ParioEventOfTopic<TTopic extends ParioEventTopic> = DomainEvent extends infer TEvent
  ? TEvent extends DomainEvent
    ? TEvent["topic"] extends TTopic
      ? StoredEvent<TEvent>
      : never
    : never
  : never
export type ParioEventForSubscription<
  TTopic extends ParioEventTopic | undefined,
  TTypes extends readonly ParioEventType[] | undefined,
> = TTypes extends readonly ParioEventType[]
  ? TTopic extends ParioEventTopic
    ? Extract<ParioEventOfType<TTypes[number]>, { topic: TTopic }>
    : ParioEventOfType<TTypes[number]>
  : TTopic extends ParioEventTopic
    ? ParioEventOfTopic<TTopic>
    : ParioEvent

export function isParioEvent(value: unknown): value is ParioEvent {
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
