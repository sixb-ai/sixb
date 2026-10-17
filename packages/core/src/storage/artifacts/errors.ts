export type ArtifactStorageErrorCode =
  | "artifact_exists"
  | "artifact_not_found"
  | "artifact_kind_mismatch"

/** Error for artifact-storage invariants. Callers branch on `code` rather than message text. */
export class ArtifactStorageError extends Error {
  readonly name = "ArtifactStorageError"

  constructor(
    readonly code: ArtifactStorageErrorCode,
    message: string
  ) {
    super(message)
  }
}
