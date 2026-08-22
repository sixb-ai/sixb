export type ShareSessionStorageErrorCode = "duplicate" | "invalid"

export class ShareSessionStorageError extends Error {
  readonly name = "ShareSessionStorageError"

  constructor(
    message: string,
    readonly code: ShareSessionStorageErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
