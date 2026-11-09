import type { Principal } from "../auth"
import type { Storage } from "../storage"

const OWNER: Principal = { type: "user", id: "usr_artifact_owner" }

/**
 * Stores a one-file document artifact straight in `storage`, for suites whose objects reference
 * artifacts: a write only gives an object an artifact that exists.
 */
export async function createStoredArtifact(
  storage: Pick<Storage, "artifacts">,
  input: { readonly projectId: string; readonly id: string }
): Promise<void> {
  const artifacts = storage.artifacts
  if (!artifacts) throw new Error("[Sixb] This suite needs storage with artifacts.")

  const hex = "a".repeat(64)
  await artifacts.create({
    projectId: input.projectId,
    id: input.id,
    kind: "document",
    owner: OWNER,
    version: {
      title: input.id,
      entry: "document.md",
      files: [
        {
          path: "document.md",
          file: {
            blobId: `blob_${hex}`,
            digest: `sha256:${hex}`,
            sizeBytes: 1,
            mediaType: "text/markdown",
          },
        },
      ],
      outline: { kind: "document", headings: [] },
      references: [],
      author: OWNER,
      updatedAt: new Date("2026-11-09T00:00:00.000Z"),
    },
  })
}
