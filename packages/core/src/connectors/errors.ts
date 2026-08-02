import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

export interface ConnectorErrorOptions extends SixbErrorOptions {
  /** Subclasses narrow the failure; direct callers of `ConnectorError` leave this alone. */
  readonly code?: SixbErrorCode
}

/**
 * Base error for the connectors module. Specific subclasses extend this
 * so callers can catch any connector-scoped failure with a single
 * `instanceof ConnectorError` check.
 *
 * The base code is `runtime.invalid_definition` because that is what the module itself raises —
 * a malformed or duplicate connector definition. A connector *call* that fails reports a
 * `connector.*` code from the connector package.
 */
export class ConnectorError extends SixbError {
  override readonly name: string = "ConnectorError"

  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(options.code ?? "runtime.invalid_definition", message, options)
  }
}

export class ConnectorNotFoundError extends ConnectorError {
  override readonly name = "ConnectorNotFoundError"

  constructor(readonly connectorId: string) {
    super(`Unknown connector '${connectorId}'`, {
      code: "connector.not_found",
      details: { connectorId },
    })
  }
}
