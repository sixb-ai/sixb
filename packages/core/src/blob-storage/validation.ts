import { blobIdFromDigest } from "./derive"
import type {
  BlobDigest,
  BlobStorage,
  DirectUploadBlobStorage,
  FileRef,
  RangeReadableBlobStorage,
} from "./types"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isBlobDigest(value: unknown): value is BlobDigest {
  return typeof value === "string" && value.startsWith("sha256:") && value.length > "sha256:".length
}

export function isFileRef(value: unknown): value is FileRef {
  return (
    isPlainObject(value) &&
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
