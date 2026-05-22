/**
 * Error for event runtime invariants and failures (e.g., unknown event
 * types encountered when converting new events to their stored form).
 */
export class EventsError extends Error {
  readonly name = "EventsError"
}
