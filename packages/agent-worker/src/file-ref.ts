import type { FileRef } from "@sixb/core"

/** Content identity used only where byte-for-byte duplicates should collapse. */
export function fileContentKey(fileRef: FileRef): string {
  return `${fileRef.digest}:${fileRef.sizeBytes}`
}

/** Exact reference identity for metadata-sensitive lookups such as sandbox paths. */
export function fileRefKey(fileRef: FileRef): string {
  return JSON.stringify([
    fileRef.blobId,
    fileRef.digest,
    fileRef.sizeBytes,
    fileRef.fileName ?? null,
    fileRef.mediaType ?? null,
    fileRef.logicalPath ?? null,
  ])
}
