import * as Y from "yjs"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import { ArtifactStorageError } from "../../storage/artifacts/errors"
import { turnUndoable } from "../../storage/artifacts/record"
import type { ArtifactFile, ArtifactStorage } from "../../storage/artifacts/types"
import { ArtifactRequestError } from "../errors"
import type { ArtifactKind } from "../kinds"
import { documentFiles, type LiveFiles, mergeIntoDocument } from "../live/document"
import { readLiveFiles, sameArtifactFiles, storeLiveFiles } from "../live/files"
import { keepsDocument, loadArtifactDocument, storeArtifactDocument } from "../live/state"

// A canvas, or a designed document, is edited by many at once, and keeps its content as a Yjs
// document (see ../live/state.ts). Every write to one is made into that document: a live editor's
// as the Yjs update it holds, any other as the changes from the files it was made from to its own.
// A write made from an earlier revision is so merged, not refused, and whatever was written
// meanwhile stays. Anything else keeps the conflict check.

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
  /** The title it writes, and the one of `baseRevision`: a title given since stays unless it changes it. */
  readonly title?: string
  readonly baseTitle?: string
  /**
   * The artifact's document as a live editor holds it, encoded as a Yjs update: merged into the
   * stored one, whose files the write then holds.
   */
  readonly update?: Uint8Array
}

/** A write as it is stored: merged when the artifact moved past its base. */
export interface MergedArtifactWrite {
  readonly files: readonly ArtifactFile[]
  readonly baseRevision?: number
  /** It was merged with what others wrote since its base. */
  readonly merged: boolean
  /** The document that holds the write's content, for a kind that keeps one. */
  readonly document?: FileRef
  /** The title to keep instead of the write's: one given since its base, which it did not change. */
  readonly title?: string
}

/**
 * The write to store. One to an artifact that keeps a document is made into that document, which
 * is stored with it, and is based on the latest revision; one that moved past its base is merged
 * into what the latest version holds now. A write whose base files are not known is left as it is,
 * for the conflict check to refuse.
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
  if (!keepsDocument(write.kind, write.files)) return unmerged

  const { projectId, storage, blobStorage } = context
  const artifact = await storage.get({ projectId, id: write.artifactId })
  const latest =
    artifact &&
    (await storage.getVersion({
      projectId,
      artifactId: artifact.id,
      version: artifact.latestVersion,
    }))
  if (!artifact || !latest || artifact.kind !== write.kind) return unmerged

  const moved = write.baseRevision !== undefined && write.baseRevision !== artifact.revision
  const doc = await loadArtifactDocument(blobStorage, artifact, latest.files)
  try {
    let merged = moved
    if (write.update) {
      Y.applyUpdate(doc, write.update)
    } else {
      // The changes from the files it was made from. Those the writer names are its base, even
      // at the latest revision: an Agent's copy may hold less than the version it was installed
      // at, which merged others' words in, and a diff from the version would take them out.
      const files = moved
        ? (write.baseFiles ??
          (await filesAtRevision(storage, projectId, artifact.id, write.baseRevision ?? 0)))
        : write.baseFiles
      if (moved && !files) return unmerged

      // Made from what the latest version holds, as after a freeze: nothing to merge with.
      let base: LiveFiles = documentFiles(doc)
      merged = files !== undefined && files !== null && !sameArtifactFiles(files, latest.files)
      if (merged && files) base = await readLiveFiles(blobStorage, files)
      mergeIntoDocument(doc, base, await readLiveFiles(blobStorage, write.files))
    }

    // Merged, the write holds what the document holds; otherwise it is stored as it was made.
    // What the write and the latest version both hold keeps its reference, the write's first.
    const files =
      merged || write.update
        ? await storeLiveFiles(blobStorage, documentFiles(doc), [...latest.files, ...write.files])
        : write.files
    const renamed =
      moved &&
      write.baseTitle !== undefined &&
      write.title === write.baseTitle &&
      artifact.title !== write.title
    return {
      files,
      baseRevision: artifact.revision,
      merged,
      document: await storeArtifactDocument(blobStorage, doc),
      ...(renamed ? { title: artifact.title } : {}),
    }
  } finally {
    doc.destroy()
  }
}

/**
 * Runs a write, merged as {@link mergeArtifactWrite} merges it, and starts over when another write
 * lands between the merge and the store: `store` then fails with `artifact_moved`, which a merged
 * kind never shows its writer.
 */
export async function withMergedWrite<T>(
  context: MergeContext,
  write: ArtifactWrite,
  store: (merged: MergedArtifactWrite) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const merged = await mergeArtifactWrite(context, write)
    try {
      return await store(merged)
    } catch (error) {
      if (
        !isMoved(error) ||
        !keepsDocument(write.kind, write.files) ||
        attempt === MERGE_ATTEMPTS
      ) {
        throw error
      }
    }
  }
}

type MergeContext = Parameters<typeof mergeArtifactWrite>[0]

/**
 * The artifact's document once it holds `files` again, as a restore or an undo puts them back:
 * the change to them, made into its stored document, and the revision that is based on. Null for
 * a kind that keeps no document, or without the artifact.
 */
export async function documentHolding(
  context: MergeContext,
  artifactId: string,
  files: readonly ArtifactFile[]
): Promise<{ readonly document: FileRef; readonly baseRevision: number } | null> {
  const { projectId, storage, blobStorage } = context
  const artifact = await storage.get({ projectId, id: artifactId })
  if (!artifact || !keepsDocument(artifact.kind, files)) return null
  const latest = await storage.getVersion({
    projectId,
    artifactId,
    version: artifact.latestVersion,
  })
  if (!latest) return null

  const doc = await loadArtifactDocument(blobStorage, artifact, latest.files)
  try {
    mergeIntoDocument(doc, documentFiles(doc), await readLiveFiles(blobStorage, files))
    return {
      document: await storeArtifactDocument(blobStorage, doc),
      baseRevision: artifact.revision,
    }
  } finally {
    doc.destroy()
  }
}

/**
 * Runs a write that puts `files` back, with the document that holds them, based on the revision
 * it was made at; it starts over when another write lands first. A caller's own `baseRevision`
 * is kept, and the write then refused past it, as it would be without a document.
 */
export async function withDocumentHolding<T>(
  context: MergeContext,
  artifactId: string,
  files: readonly ArtifactFile[] | null,
  baseRevision: number | undefined,
  store: (held: { readonly document?: FileRef; readonly baseRevision?: number }) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const held = files ? await documentHolding(context, artifactId, files) : null
    const base = baseRevision ?? held?.baseRevision
    const fits = held && (baseRevision === undefined || baseRevision === held.baseRevision)
    try {
      return await store({
        ...(fits ? { document: held.document } : {}),
        ...(base === undefined ? {} : { baseRevision: base }),
      })
    } catch (error) {
      if (!isMoved(error) || baseRevision !== undefined || !held || attempt === MERGE_ATTEMPTS) {
        throw error
      }
    }
  }
}

/**
 * The documents of the artifacts a retry of a turn puts back, by id: each one the undo will put
 * back, as the turn's restore point holds it. Made before the undo, at the revision it requires,
 * so the undo can store them: one written meanwhile is not undone, and its document goes unused.
 */
export async function undoneTurnDocuments(
  context: MergeContext,
  turnRunId: string
): Promise<Record<string, FileRef>> {
  const { projectId, storage } = context
  const documents: Record<string, FileRef> = {}

  for (const write of await storage.listTurnWrites({ projectId, turnRunId })) {
    if (write.created) continue
    const artifact = await storage.get({ projectId, id: write.artifactId })
    // Only a canvas's or a document's files are held in a live document.
    if (!artifact || (artifact.kind !== "canvas" && artifact.kind !== "document")) continue

    // Undone by the rule the undo applies, at the revision it will find.
    const points = await storage.listRestorePoints({ projectId, id: artifact.id })
    const point = points.find((each) => each.turnRunId === turnRunId)
    const target =
      point &&
      (await storage.getVersion({ projectId, artifactId: artifact.id, version: point.version }))
    const undoable = turnUndoable({
      write,
      revision: artifact.revision,
      ...(point ? { point } : {}),
      ...(target ? { target: { frozen: target.frozenAt !== undefined } } : {}),
    })
    if (!point || !undoable || !keepsDocument(artifact.kind, point.files)) continue

    const held = await documentHolding(context, artifact.id, point.files)
    if (held?.baseRevision === artifact.revision) documents[artifact.id] = held.document
  }
  return documents
}

function isMoved(error: unknown): boolean {
  return (
    (error instanceof ArtifactRequestError || error instanceof ArtifactStorageError) &&
    error.code === "artifact_moved"
  )
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
