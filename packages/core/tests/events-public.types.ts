import type { DomainEventLog } from "../src"

declare const events: DomainEventLog

void events.read()
void events.latestCursor()

// Persisted ontology envelopes are published only by the internal outbox dispatcher.
// @ts-expect-error Stable envelope publication is intentionally absent from the public facade.
void events.publishEnvelopes([])
