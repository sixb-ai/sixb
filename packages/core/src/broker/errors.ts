import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

export interface BrokerErrorOptions extends SixbErrorOptions {
  /** Subclasses narrow the failure; direct callers of `BrokerError` leave this alone. */
  readonly code?: Extract<SixbErrorCode, `broker.${string}`>
}

export class BrokerError extends SixbError {
  override readonly name: string = "BrokerError"

  constructor(message: string, options: BrokerErrorOptions = {}) {
    super(options.code ?? "broker.unavailable", `[Broker] ${message}`, options)
  }
}

/**
 * Raised when retention has removed the cursor a consumer wants to resume
 * from. Transports use this provider-independent type to request a reset.
 */
export class BrokerCursorExpiredError extends BrokerError {
  override readonly name = "BrokerCursorExpiredError"

  constructor(message: string, options: SixbErrorOptions = {}) {
    super(message, { ...options, code: "broker.cursor_expired" })
  }
}
