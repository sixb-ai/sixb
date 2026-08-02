import { SixbError, type SixbErrorOptions } from "../errors"

/**
 * A broken invariant inside the objects module — a materializer that returned no outcome for a
 * write it accepted. Nothing the caller sent can produce this, which is why it is not a validation
 * error.
 */
export class ObjectError extends SixbError {
  override readonly name = "ObjectError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invariant_violated", message, options)
  }
}
