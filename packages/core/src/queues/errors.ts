import { type SixbErrorOptions, SixbValidationError } from "../errors"

/**
 * Error for queue invariants and invalid queue operations.
 *
 * `runtime.invalid_input` rather than `queue.unavailable`: this is raised when Sixb is handed a
 * malformed job or asked for a transition the job is not in, never when the queue itself is down.
 * A provider reports that as `queue.unavailable`.
 */
export class QueueError extends SixbValidationError {
  override readonly name = "QueueError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_input", message, options)
  }
}
