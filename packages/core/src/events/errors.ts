import { SixbError, type SixbErrorOptions } from "../errors"

/**
 * A broken invariant in the event runtime — an envelope whose type no ontology knows, a payload the
 * broker cannot carry. The events themselves are framework-produced, so this is never bad input.
 */
export class EventsError extends SixbError {
  override readonly name = "EventsError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invariant_violated", message, options)
  }
}
