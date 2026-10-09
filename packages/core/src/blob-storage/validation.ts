import { isPlainRecord } from "../json"
import { blobIdFromDigest } from "./derive"
import { canonicalMediaType } from "./media-type"
import type {
  BlobDigest,
  BlobStorage,
  DirectUploadBlobStorage,
  FileRef,
  RangeReadableBlobStorage,
} from "./types"

export function isBlobDigest(value: unknown): value is BlobDigest {
  return typeof value === "string" && value.startsWith("sha256:") && value.length > "sha256:".length
}

export function isFileRef(value: unknown): value is FileRef {
  return (
    isPlainRecord(value) &&
    typeof value.blobId === "string" &&
    value.blobId.trim().length > 0 &&
    isBlobDigest(value.digest) &&
    // Blob identity is content-addressed: the id must be derivable from the digest.
    // Rejecting a mismatch guards against tampered or malformed references.
    value.blobId === blobIdFromDigest(value.digest) &&
    typeof value.sizeBytes === "number" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    (value.fileName === undefined || typeof value.fileName === "string") &&
    (value.mediaType === undefined || typeof value.mediaType === "string") &&
    (value.logicalPath === undefined || typeof value.logicalPath === "string")
  )
}

/**
 * `isFileRef`, plus a `mediaType` that, when present, is exactly one media type. Paths that store
 * a reference a caller hands them use this. Reads keep `isFileRef`, so references stored before
 * the rule still load; file routes re-parse the type before serving it.
 */
export function isValidFileRef(value: unknown): value is FileRef {
  return (
    isFileRef(value) &&
    (value.mediaType === undefined || canonicalMediaType(value.mediaType) !== null)
  )
}

export function supportsDirectUpload(
  storage: BlobStorage
): storage is BlobStorage & DirectUploadBlobStorage {
  const candidate = storage as Partial<DirectUploadBlobStorage>
  return (
    typeof candidate.createUpload === "function" &&
    typeof candidate.signUploadPart === "function" &&
    typeof candidate.completeUpload === "function" &&
    typeof candidate.abortUpload === "function"
  )
}

export function supportsRangeRead(
  storage: BlobStorage
): storage is BlobStorage & RangeReadableBlobStorage {
  const candidate = storage as Partial<RangeReadableBlobStorage>
  return typeof candidate.openRange === "function"
}
