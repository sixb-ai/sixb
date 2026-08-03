import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

export interface BrokerErrorOptions extends SixbErrorOptions {
  /** Narrows the failure past the module default; most callers leave this alone. */
  readonly code?: Extract<SixbErrorCode, `broker.${string}`>
}

/**
 * A broker failure, prefixed and defaulted to `broker.unavailable`.
 *
 * Pass `code: "broker.cursor_expired"` when retention has removed the cursor a consumer wants to
 * resume from: that code is provider-independent, and asking for a reset is the one branch a
 * consumer takes on a broker error.
 */
export function brokerError(message: string, options: BrokerErrorOptions = {}): SixbError {
  return new SixbError(options.code ?? "broker.unavailable", `[Broker] ${message}`, options)
}
