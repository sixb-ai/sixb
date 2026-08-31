export type ShareSessionStorageErrorCode = "duplicate" | "invalid_input" | "invalid_record"

/** Provider-level control signal for durable Share session persistence. */
export class ShareSessionStorageError extends Error {
  readonly name = "ShareSessionStorageError"

  constructor(
    readonly code: ShareSessionStorageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
