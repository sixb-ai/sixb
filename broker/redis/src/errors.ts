import { BrokerError } from "@pario/core"

/** Error class for Redis Streams-backed broker failures. */
export class RedisBrokerError extends BrokerError {
  override readonly name = "RedisBrokerError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.message = `[RedisBroker] ${message}`
  }
}
