/**
 * Transport-agnostic reasons a file upload session operation can fail. Mapping a
 * reason to an HTTP status (or any other transport) is the responsibility of the
 * boundary that surfaces it, not of core.
 */
export type FileUploadSessionErrorReason =
  | "not_found"
  | "expired"
  | "already_completed"
  | "already_aborted"

/**
 * Error for file upload session invariants and invalid state transitions.
 */
export class FileUploadSessionError extends Error {
  readonly name = "FileUploadSessionError"

  constructor(
    readonly reason: FileUploadSessionErrorReason,
    message: string
  ) {
    super(message)
  }
}
