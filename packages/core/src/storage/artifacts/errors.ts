import type { Principal } from "../../auth"

export type ArtifactStorageErrorCode =
  | "artifact_exists"
  | "artifact_not_found"
  | "artifact_kind_mismatch"
  | "artifact_moved"
  | "artifact_state_full"
  | "restore_point_not_found"

/**
 * Where an artifact had moved on to when a write found it moved: its latest version, its
 * revision, and who last wrote that version's content.
 */
export interface ArtifactLatestVersion {
  readonly version: number
  readonly revision: number
  readonly author: Principal
}

/** Error for artifact-storage invariants. Callers branch on `code` rather than message text. */
export class ArtifactStorageError extends Error {
  readonly name = "ArtifactStorageError"

  constructor(
    readonly code: ArtifactStorageErrorCode,
    message: string,
    /** With `artifact_moved`: where the artifact is, which the write was not based on. */
    readonly latest?: ArtifactLatestVersion
  ) {
    super(message)
  }
}
