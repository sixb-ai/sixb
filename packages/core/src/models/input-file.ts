import { createHash } from "node:crypto"
import type { BlobStorage, FileRef } from "../blob-storage/types"
import { isFileRef } from "../blob-storage/validation"

/** Snapshot caller-owned metadata before model resolution or storage introduces an await. */
export function prepareModelInputFile(
  input: FileRef,
  type: "audio" | "image"
): { file: FileRef; mediaType: string } {
  if (!isFileRef(input) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new TypeError(`[SixbModels] ${capitalize(type)} input must be a nonempty FileRef.`)
  }

  const file = { ...input }
  const mediaType = file.mediaType?.split(";", 1)[0]?.trim().toLowerCase()
  if (!mediaType || !new RegExp(`^${type}/[a-z0-9.+-]+$`).test(mediaType)) {
    throw new TypeError(
      `[SixbModels] ${capitalize(type)} FileRef must declare an ${type} mediaType.`
    )
  }

  return { file, mediaType }
}

function capitalize(type: "audio" | "image"): string {
  return type === "audio" ? "Audio" : "Image"
}

/** Read an already validated reference, bounded by its verified size and the model's limit. */
export async function readModelInputFile(
  storage: BlobStorage,
  file: FileRef,
  signal: AbortSignal
): Promise<Uint8Array> {
  const info = await storage.stat(file.blobId)
  signal.throwIfAborted()
  if (
    !info ||
    info.blobId !== file.blobId ||
    info.digest !== file.digest ||
    info.sizeBytes !== file.sizeBytes
  ) {
    throw new Error("[SixbModels] File reference does not match the stored file.")
  }

  const stream = await storage.open(file.blobId)
  const reader = stream.getReader()
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })

  let complete = false
  try {
    signal.throwIfAborted()

    const bytes = new Uint8Array(file.sizeBytes)
    const hash = createHash("sha256")
    let offset = 0

    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      if (!(value instanceof Uint8Array) || value.byteLength > bytes.byteLength - offset) {
        throw new Error("[SixbModels] File stream exceeds its declared size.")
      }

      bytes.set(value, offset)
      hash.update(value)
      offset += value.byteLength
    }

    if (offset !== file.sizeBytes || `sha256:${hash.digest("hex")}` !== file.digest) {
      throw new Error("[SixbModels] File stream does not match its content-addressed reference.")
    }

    complete = true
    return bytes
  } finally {
    signal.removeEventListener("abort", cancel)
    if (!complete) {
      void reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}
