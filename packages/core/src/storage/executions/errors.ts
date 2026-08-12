export type ExecutionStorageErrorCode =
  | "duplicate_execution"
  | "invalid_credential"
  | "invalid_input"
  | "invalid_parent_execution"
  | "missing_credential"
  | "missing_parent_execution"
  | "missing_principal"

/** Stable error raised when an execution record would violate ledger invariants. */
export class ExecutionStorageError extends Error {
  readonly name = "ExecutionStorageError"

  constructor(
    readonly code: ExecutionStorageErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options)
  }
}
