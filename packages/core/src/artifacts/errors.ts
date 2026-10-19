import type { ArtifactLatestVersion } from "../storage/artifacts/errors"

export type ArtifactRequestErrorCode =
  | "artifact_not_found"
  | "artifact_kind_mismatch"
  | "artifact_moved"
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
    message: string,
    /** With `artifact_moved`: the latest version, which the publish was not based on. */
    readonly latest?: ArtifactLatestVersion
  ) {
    super(message)
  }
}
