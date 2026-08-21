export type ShareErrorReason =
  | "invalid_definition"
  | "invalid_input"
  | "not_found"
  | "storage_unavailable"
  | "unauthenticated"

export class ShareError extends Error {
  readonly name = "ShareError"

  constructor(
    readonly reason: ShareErrorReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
