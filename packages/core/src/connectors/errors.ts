/**
 * Base error for the connectors module. Specific subclasses extend this
 * so callers can catch any connector-scoped failure with a single
 * `instanceof ConnectorError` check.
 */
export class ConnectorError extends Error {
  readonly name: string = "ConnectorError"
}

export class ConnectorNotFoundError extends ConnectorError {
  override readonly name = "ConnectorNotFoundError"
  constructor(readonly connectorId: string) {
    super(`Unknown connector '${connectorId}'`)
  }
}

export type ConnectorOAuthErrorKind = "retryable" | "terminal"

/** Adapter signal used by Core to decide whether credentials require reauthorization. */
export class ConnectorOAuthError extends ConnectorError {
  override readonly name = "ConnectorOAuthError"

  constructor(
    readonly kind: ConnectorOAuthErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
