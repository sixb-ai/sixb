export class BrokerError extends Error {
  readonly name: string = "BrokerError"

  constructor(message: string, options?: ErrorOptions) {
    super(`[Broker] ${message}`, options)
  }
}

/**
 * Raised when retention has removed the cursor a consumer wants to resume
 * from. Transports use this provider-independent type to request a reset.
 */
export class BrokerCursorExpiredError extends BrokerError {
  override readonly name = "BrokerCursorExpiredError"
}
