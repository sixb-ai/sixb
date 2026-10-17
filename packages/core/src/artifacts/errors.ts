export type ArtifactRequestErrorCode =
  | "artifact_not_found"
  | "artifact_kind_mismatch"
  | "invalid_artifact"
  | "not_allowed"
  | "storage_unavailable"

/**
 * Error for an artifact request the caller can correct or must be told about. Callers branch on
 * `code`; the message says what to change.
 */
export class ArtifactRequestError extends Error {
  readonly name = "ArtifactRequestError"

  constructor(
    readonly code: ArtifactRequestErrorCode,
    message: string
  ) {
    super(message)
  }
}
