import type { ArtifactLatestVersion } from "../storage/artifacts/errors"

export type ArtifactRequestErrorCode =
  | "artifact_not_found"
  | "artifact_kind_mismatch"
  | "artifact_moved"
  | "comment_not_found"
  | "comments_full"
  | "invalid_artifact"
  | "invalid_comment"
  | "invalid_state"
  | "state_full"
  | "not_allowed"
  | "not_shared"
  | "query_invalid"
  | "query_not_found"
  | "read_only"
  | "restore_point_not_found"
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
    /** With `artifact_moved`: where the artifact is, which the write was not based on. */
    readonly latest?: ArtifactLatestVersion
  ) {
    super(message)
  }
}
