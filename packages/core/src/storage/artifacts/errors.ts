import type { Principal } from "../../auth"

export type ArtifactStorageErrorCode =
  | "artifact_exists"
  | "artifact_not_found"
  | "artifact_kind_mismatch"
  | "artifact_moved"

/** The version an artifact had moved on to, and who published it, when a publish found it moved. */
export interface ArtifactLatestVersion {
  readonly version: number
  readonly author: Principal
}

/** Error for artifact-storage invariants. Callers branch on `code` rather than message text. */
export class ArtifactStorageError extends Error {
  readonly name = "ArtifactStorageError"

  constructor(
    readonly code: ArtifactStorageErrorCode,
    message: string,
    /** With `artifact_moved`: the latest version, which the publish was not based on. */
    readonly latest?: ArtifactLatestVersion
  ) {
    super(message)
  }
}
