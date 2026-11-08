import type { BlobStorage } from "../../blob-storage/types"
import { ArtifactStorageError } from "../../storage/artifacts/errors"
import type { ArtifactFile, ArtifactStorage } from "../../storage/artifacts/types"
import { ArtifactRequestError } from "../errors"
import type { ArtifactKind } from "../kinds"
import { createArtifactDocument, documentFiles, mergeIntoDocument } from "../live/document"
import { readLiveFiles, sameArtifactFiles, storeLiveFiles } from "../live/files"

// A canvas is edited by many at once: a write made from an earlier revision is not refused but
// merged into what the latest version holds now, as a diff against the files it was made from,
// so whatever was written meanwhile stays. Any other kind keeps the conflict check.

/** The kinds whose writes merge rather than conflict. */
const MERGED_KINDS: ReadonlySet<ArtifactKind> = new Set(["canvas"])

/** How many times a merged write starts over when another lands between its merge and its store. */
const MERGE_ATTEMPTS = 3

/** A write to an artifact, made from the files of `baseRevision`. */
export interface ArtifactWrite {
  readonly artifactId: string
  readonly kind: ArtifactKind
  readonly files: readonly ArtifactFile[]
  readonly baseRevision?: number
  /** The files of `baseRevision`, when the writer holds them; otherwise looked up. */
  readonly baseFiles?: readonly ArtifactFile[]
}

/** A write as it is stored: merged when the artifact moved past its base. */
export interface MergedArtifactWrite {
  readonly files: readonly ArtifactFile[]
  readonly baseRevision?: number
  /** It was merged with what others wrote since its base. */
  readonly merged: boolean
}

/**
 * The write to store: as it is unless it is to a canvas that moved past its base revision, then
 * merged into the latest version's files, based on the latest revision. One whose base files are
 * not known is left as it is, for the conflict check to refuse.
 */
export async function mergeArtifactWrite(
  context: {
    readonly projectId: string
    readonly storage: ArtifactStorage
    readonly blobStorage: Pick<BlobStorage, "open" | "put">
  },
  write: ArtifactWrite
): Promise<MergedArtifactWrite> {
  const unmerged = {
    files: write.files,
    ...(write.baseRevision === undefined ? {} : { baseRevision: write.baseRevision }),
    merged: false,
  }
  if (!MERGED_KINDS.has(write.kind) || write.baseRevision === undefined) return unmerged

  const { projectId, storage } = context
  const artifact = await storage.get({ projectId, id: write.artifactId })
  if (!artifact || artifact.kind !== write.kind || artifact.revision === write.baseRevision) {
    return unmerged
  }

  const latest = await storage.getVersion({
    projectId,
    artifactId: artifact.id,
    version: artifact.latestVersion,
  })
  const base =
    write.baseFiles ?? (await filesAtRevision(storage, projectId, artifact.id, write.baseRevision))
  if (!latest || !base) return unmerged

  // Moved without changing its files, as a freeze moves it: nothing to merge with.
  if (sameArtifactFiles(base, latest.files)) {
    return { files: write.files, baseRevision: artifact.revision, merged: false }
  }

  const [baseFiles, currentFiles, nextFiles] = await Promise.all(
    [base, latest.files, write.files].map((files) => readLiveFiles(context.blobStorage, files))
  )
  const doc = createArtifactDocument(write.kind, currentFiles)
  mergeIntoDocument(doc, baseFiles, nextFiles)

  // What the write and the latest version both hold keeps its reference, the write's first.
  const files = await storeLiveFiles(context.blobStorage, documentFiles(doc), [
    ...latest.files,
    ...write.files,
  ])
  return { files, baseRevision: artifact.revision, merged: true }
}

/**
 * Runs a write, merged as {@link mergeArtifactWrite} merges it, and starts over when another write
 * lands between the merge and the store: `store` then fails with `artifact_moved`, which a merged
 * kind never shows its writer.
 */
export async function withMergedWrite<T>(
  context: Parameters<typeof mergeArtifactWrite>[0],
  write: ArtifactWrite,
  store: (merged: MergedArtifactWrite) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const merged = await mergeArtifactWrite(context, write)
    try {
      return await store(merged)
    } catch (error) {
      const moved =
        (error instanceof ArtifactRequestError || error instanceof ArtifactStorageError) &&
        error.code === "artifact_moved"
      if (!moved || !MERGED_KINDS.has(write.kind) || attempt === MERGE_ATTEMPTS) throw error
    }
  }
}

/**
 * The files the artifact held at a revision, when something still holds them: its latest version,
 * one of its versions, or a restore point. Null for a revision since replaced.
 */
async function filesAtRevision(
  storage: ArtifactStorage,
  projectId: string,
  artifactId: string,
  revision: number
): Promise<readonly ArtifactFile[] | null> {
  const point = await storage.getRestorePoint({ projectId, artifactId, revision })
  if (point) return point.files

  const { versions } = await storage.listVersions({ projectId, artifactId, limit: 50 })
  return versions.find((version) => version.revision === revision)?.files ?? null
}
