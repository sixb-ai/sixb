// Browser-safe blob-storage surface: the FileRef contract plus pure helpers that
// never reach `node:crypto`. Client and UI code should import from
// `@sixb/core/blob-storage` (this module) rather than the root `@sixb/core`
// barrel, which co-bundles the Node-only provider utilities.

import type { FileRef } from "./types"

export { DEFAULT_SIMPLE_FILE_UPLOAD_BYTES } from "./constants"
export { blobDigestHex, blobIdFromDigest } from "./derive"
export type { BlobDigest, BlobInfo, FileRef } from "./types"
export { isBlobDigest, isFileRef } from "./validation"

/**
 * Best-effort display name for a file reference: the trailing path segment of
 * `fileName`, else of `logicalPath`, else a synthetic `<blobId>.bin`.
 *
 * `fileName`/`logicalPath` are untrusted caller metadata; callers that render or
 * set headers with the result must still sanitize it.
 */
export function fileNameFor(fileRef: FileRef): string {
  const fromFileName = fileRef.fileName?.split(/[\\/]/).filter(Boolean).at(-1)
  if (fromFileName) {
    return fromFileName
  }

  const fromLogicalPath = fileRef.logicalPath?.split(/[\\/]/).filter(Boolean).at(-1)
  return fromLogicalPath || `${fileRef.blobId}.bin`
}
