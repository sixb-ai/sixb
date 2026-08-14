import type {
  BrokerCursor,
  DomainEventLog,
  EventsAppendInput,
  EventsEmitOptions,
  EventsReadInput,
  EventsSubscribeInput,
  StoredDomainEvent,
} from "../src"

declare const events: DomainEventLog

void events.read()
void events.latestCursor()

// Persisted ontology envelopes are published only by the internal outbox dispatcher.
// @ts-expect-error Stable envelope publication is intentionally absent from the public facade.
void events.publishEnvelopes([])

/**
 * Every type in a public signature has to be nameable from the same surface as the interface, or the
 * interface cannot be annotated — let alone implemented — from outside. Writing the port out by hand
 * with root-exported names only is the check: an unexported type fails to resolve here.
 *
 * This caught real holes. `EventsEmitOptions` was exported nowhere at all, so `emit`'s second
 * parameter had no name, and `StoredDomainEvent` never reached the root even though `append` returns
 * it and the public execution-bound `Sixb.events.read()` returns it.
 */
declare const handWritten: {
  append(input: EventsAppendInput): Promise<readonly StoredDomainEvent[]>
  emit(input: EventsAppendInput, options: EventsEmitOptions): Promise<void>
  read(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
  latestCursor(): Promise<string | undefined>
  subscribe(
    input: EventsSubscribeInput,
    handler: (events: readonly StoredDomainEvent[]) => void
  ): Promise<() => void>
}

const _portIsWritableFromTheRoot: DomainEventLog = handWritten
const _portHasNothingElse: typeof handWritten = events

const _cursor: BrokerCursor = "evt-0000000001"
const _resumeFromCursor: EventsSubscribeInput = { afterCursor: _cursor }
