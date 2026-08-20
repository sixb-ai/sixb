export type ConnectorConnectionStorageErrorCode =
  | "attempt_conflict"
  | "attempt_invalid"
  | "authorization_conflict"
  | "connection_conflict"
  | "invalid_input"

export class ConnectorConnectionStorageError extends Error {
  readonly code: ConnectorConnectionStorageErrorCode

  constructor(code: ConnectorConnectionStorageErrorCode, message: string) {
    super(message)
    this.name = "ConnectorConnectionStorageError"
    this.code = code
  }
}
