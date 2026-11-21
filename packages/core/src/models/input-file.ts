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
  const mediaType = modelInputMediaType(file.mediaType, type)
  if (!mediaType) {
    throw new TypeError(
      `[SixbModels] ${capitalize(type)} FileRef must declare an ${type} mediaType.`
    )
  }

  return { file, mediaType }
}

/** Copy caller-owned bytes, so changing the array after the call cannot reach the model. */
export function prepareModelInputBytes(
  input: { readonly data: unknown; readonly mediaType: unknown },
  type: "audio"
): { bytes: Uint8Array; mediaType: string } {
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) {
    throw new TypeError(`[SixbModels] ${capitalize(type)} data must be a nonempty Uint8Array.`)
  }

  const mediaType = modelInputMediaType(input.mediaType, type)
  if (!mediaType) {
    throw new TypeError(`[SixbModels] ${capitalize(type)} data must declare an ${type} mediaType.`)
  }

  return { bytes: input.data.slice(), mediaType }
}

/**
 * The registered name of an audio format some systems label by an older alias. A stored file
 * often carries the alias whatever its uploader declared: Bun types a multipart part by its file
 * name, so `talk.m4a` sent as `audio/mp4` is stored as `audio/x-m4a`. Providers key on the
 * registered name; through the Gateway, an `.m4a` stored under its alias was refused.
 */
const AUDIO_ALIASES: Readonly<Record<string, string>> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-flac": "audio/flac",
  "audio/x-aac": "audio/aac",
  "audio/mp3": "audio/mpeg",
}

/**
 * The essence of a media type, such as `audio/webm` for `audio/webm;codecs=opus`, under its
 * registered name.
 */
function modelInputMediaType(value: unknown, type: "audio" | "image"): string | undefined {
  if (typeof value !== "string") return undefined

  const essence = value.split(";", 1)[0]?.trim().toLowerCase()
  const mediaType = essence && (AUDIO_ALIASES[essence] ?? essence)
  return mediaType && new RegExp(`^${type}/[a-z0-9.+-]+$`).test(mediaType) ? mediaType : undefined
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
