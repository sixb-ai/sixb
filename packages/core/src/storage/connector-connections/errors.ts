export type ConnectorConnectionStorageErrorCode =
  | "attempt_conflict"
  | "attempt_invalid"
  | "authorization_conflict"
  | "connection_conflict"
  | "invalid_input"

/**
 * Storage-provider control signal for atomic conflicts and invalid calls.
 *
 * These codes belong to the provider contract, not `SixbErrorCode`; Core translates errors that
 * cross the connector lifecycle boundary into documented `connector.*` failures.
 */
export class ConnectorConnectionStorageError extends Error {
  readonly code: ConnectorConnectionStorageErrorCode

  constructor(code: ConnectorConnectionStorageErrorCode, message: string) {
    super(message)
    this.name = "ConnectorConnectionStorageError"
    this.code = code
  }
}
