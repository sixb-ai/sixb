import { BrokerError } from "@sixb/core/broker"

/** Error class for NATS-backed broker failures. */
export class NatsBrokerError extends BrokerError {
  override readonly name = "NatsBrokerError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.message = `[NatsBroker] ${message}`
  }
}
