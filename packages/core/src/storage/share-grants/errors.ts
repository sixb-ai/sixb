export type ShareGrantStorageErrorCode = "duplicate" | "invalid"

export class ShareGrantStorageError extends Error {
  readonly name = "ShareGrantStorageError"

  constructor(
    message: string,
    readonly code: ShareGrantStorageErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
