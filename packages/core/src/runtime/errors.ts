import { SixbError, type SixbErrorOptions } from "../errors"

/**
 * Runtime setup, lifecycle, and internal invariant failures that are not validation errors —
 * duplicate registrations, missing bootstrap resources, module load failures.
 *
 * `runtime.invalid_definition` and not `runtime.invariant_violated`: every one of these is
 * something the project's own configuration got wrong, and the answer is to fix the project, not to
 * retry. Both answer 500 for the same reason — no request could have caused it.
 */
export class RuntimeError extends SixbError {
  override readonly name = "RuntimeError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
