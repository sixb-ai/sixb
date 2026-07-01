import type { BlobDigest } from "./types"

// Pure, crypto-free derivations of blob identity from a digest. Kept out of
// `utils.ts` (which imports `node:crypto`) so the browser-safe `./browser`
// barrel can reuse them without dragging Node crypto into the client bundle.

export function blobDigestHex(digest: BlobDigest): string {
  return digest.slice("sha256:".length)
}

export function blobIdFromDigest(digest: BlobDigest): string {
  return `blob_${blobDigestHex(digest)}`
}
