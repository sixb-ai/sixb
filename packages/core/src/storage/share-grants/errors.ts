export type ShareGrantStorageErrorCode = "duplicate" | "invalid_input" | "invalid_record"

/** Provider-level control signal; Core maps it to the public Share lifecycle error vocabulary. */
export class ShareGrantStorageError extends Error {
  readonly name = "ShareGrantStorageError"

  constructor(
    readonly code: ShareGrantStorageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
