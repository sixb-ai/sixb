import type { BlobDigest, FileRef } from "./types"

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
    typeof value.sizeBytes === "number" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    (value.fileName === undefined || typeof value.fileName === "string") &&
    (value.mediaType === undefined || typeof value.mediaType === "string") &&
    (value.logicalPath === undefined || typeof value.logicalPath === "string")
  )
}
