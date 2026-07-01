import { createHash } from "node:crypto"
import type { BlobDigest, BlobInfo, FileRef, PutBlobInput } from "./types"

export async function readBlobBody(input: PutBlobInput["body"]): Promise<Uint8Array> {
  // Hashing requires a stable byte buffer regardless of the caller's body shape.
  if (input instanceof Uint8Array) {
    return new Uint8Array(input)
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input.slice(0))
  }

  if (input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer())
  }

  const reader = input.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    const chunk = new Uint8Array(value)
    chunks.push(chunk)
    totalBytes += chunk.byteLength
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

export function computeBlobDigest(bytes: Uint8Array): BlobDigest {
  const hash = createHash("sha256").update(bytes).digest("hex")
  return `sha256:${hash}`
}

export function createFileRef(input: PutBlobInput, info: BlobInfo): FileRef {
  return {
    blobId: info.blobId,
    digest: info.digest,
    sizeBytes: info.sizeBytes,
    ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
    ...(input.logicalPath !== undefined ? { logicalPath: input.logicalPath } : {}),
  }
}
