export class BrokerError extends Error {
  readonly name: string = "BrokerError"

  constructor(message: string, options?: ErrorOptions) {
    super(`[Broker] ${message}`, options)
  }
}
