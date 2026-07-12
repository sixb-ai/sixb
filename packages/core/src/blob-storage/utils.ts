import { createHash } from "node:crypto"
import { BlobStorageError } from "./errors"
import type { BlobBody, BlobDigest, BlobInfo, FileRef, PutBlobInput } from "./types"

/** Normalize every supported blob body to the streaming representation used by providers. */
export function streamBlobBody(input: BlobBody): ReadableStream<Uint8Array> {
  if (input instanceof ReadableStream) {
    return input
  }

  if (input instanceof Blob) {
    return input.stream()
  }

  if (input instanceof ArrayBuffer) {
    return new Blob([input.slice(0)]).stream()
  }

  const bytes = new Uint8Array(new ArrayBuffer(input.byteLength))
  bytes.set(input)
  return new Blob([bytes]).stream()
}

export async function readBlobBody(
  input: PutBlobInput["body"],
  signal?: AbortSignal
): Promise<Uint8Array> {
  // In-memory providers intentionally materialize bodies; durable providers should stream instead.
  signal?.throwIfAborted()

  if (input instanceof Uint8Array) {
    return new Uint8Array(input)
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input.slice(0))
  }

  if (input instanceof Blob) {
    const bytes = new Uint8Array(await input.arrayBuffer())
    signal?.throwIfAborted()
    return bytes
  }

  const reader = input.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason)
  }
  signal?.addEventListener("abort", cancelOnAbort, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        break
      }

      const chunk = new Uint8Array(value)
      chunks.push(chunk)
      totalBytes += chunk.byteLength
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

export function assertExpectedBlobSize(
  expectedSizeBytes: number | undefined,
  actualSizeBytes: number,
  provider = "BlobStorage"
): void {
  assertValidExpectedBlobSize(expectedSizeBytes, provider)
  if (expectedSizeBytes === undefined) {
    return
  }

  if (actualSizeBytes !== expectedSizeBytes) {
    throw new BlobStorageError(
      `[${provider}] Blob size mismatch: expected ${expectedSizeBytes} bytes, received ${actualSizeBytes}.`
    )
  }
}

export function assertValidExpectedBlobSize(
  expectedSizeBytes: number | undefined,
  provider = "BlobStorage"
): void {
  if (expectedSizeBytes === undefined) {
    return
  }

  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
    throw new BlobStorageError(
      `[${provider}] expectedSizeBytes must be a non-negative safe integer.`
    )
  }
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
