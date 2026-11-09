import * as Y from "yjs"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import type { ArtifactDocument, ArtifactFile, ArtifactRecord } from "../../storage/artifacts/types"
import type { ArtifactKind } from "../kinds"
import { createArtifactDocument, documentFiles, mergeIntoDocument } from "./document"
import { readLiveFiles } from "./files"

// An artifact's document as storage keeps it: its whole Yjs state in one blob, replaced by every
// write. Everyone who loads it, a server holding it live or a write merging into it, continues
// the same history, so their changes merge as Yjs merges concurrent edits.

/** Whether a kind is edited live, and so keeps its content as a document. */
export function keepsDocument(kind: ArtifactKind): boolean {
  return kind === "canvas"
}

/**
 * The artifact's document, holding `files`, its latest version's.
 *
 * - The one storage keeps, when it holds the artifact's revision.
 * - One storage left behind, written without a document since: that one, then the change from what
 *   it holds to `files`.
 * - None yet: one built from `files`.
 *
 * The last two are made under a client id named by what they start from and the files, so that
 * whoever makes one, wherever, makes the same history; the next write stores it. The document's
 * own changes are made under a fresh id.
 */
export async function loadArtifactDocument(
  blobStorage: Pick<BlobStorage, "open">,
  artifact: Pick<ArtifactRecord, "id" | "kind" | "revision" | "document">,
  files: readonly ArtifactFile[]
): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const stored = artifact.document
  if (stored?.revision === artifact.revision) {
    Y.applyUpdate(doc, await readDocumentState(blobStorage, stored.file))
    return doc
  }

  const clientID = madeClientId(artifact.id, stored, files)
  const live = await readLiveFiles(blobStorage, files)
  let made: Y.Doc
  if (stored) {
    made = new Y.Doc()
    made.clientID = clientID
    Y.applyUpdate(made, await readDocumentState(blobStorage, stored.file))
    mergeIntoDocument(made, documentFiles(made), live)
  } else {
    made = createArtifactDocument(artifact.kind, live, { clientID })
  }

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(made))
  made.destroy()
  return doc
}

/** The encoded state storage keeps of an artifact's document. */
export async function readDocumentState(
  blobStorage: Pick<BlobStorage, "open">,
  document: FileRef
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await blobStorage.open(document.blobId)).arrayBuffer())
}

/** Stores a document's whole state, for the write that holds its content. */
export async function storeArtifactDocument(
  blobStorage: Pick<BlobStorage, "put">,
  doc: Y.Doc
): Promise<FileRef> {
  const body = Y.encodeStateAsUpdate(doc)
  return blobStorage.put({
    body,
    expectedSizeBytes: body.byteLength,
    fileName: "document.yjs",
    mediaType: "application/octet-stream",
  })
}

/** The document of a new artifact's first version, for a kind that keeps one. */
export async function firstArtifactDocument(
  blobStorage: Pick<BlobStorage, "open" | "put">,
  kind: ArtifactKind,
  files: readonly ArtifactFile[]
): Promise<FileRef | undefined> {
  if (!keepsDocument(kind)) return undefined
  const doc = createArtifactDocument(kind, await readLiveFiles(blobStorage, files))
  try {
    return await storeArtifactDocument(blobStorage, doc)
  } finally {
    doc.destroy()
  }
}

/**
 * A Yjs client id named by what a document is made from: FNV-1a over the artifact, the document
 * left behind, if any, and each file's path and digest.
 */
function madeClientId(
  artifactId: string,
  stored: ArtifactDocument | undefined,
  files: readonly ArtifactFile[]
): number {
  const named = [...files]
    .map(({ path, file }) => `${path}\u0000${file.digest}`)
    .sort()
    .join("\u0001")
  const from = stored ? `${stored.file.digest}@${stored.revision}` : ""
  let hash = 0x811c9dc5
  for (const char of `${artifactId}\u0002${from}\u0002${named}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}
