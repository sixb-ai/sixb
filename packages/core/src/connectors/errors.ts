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
