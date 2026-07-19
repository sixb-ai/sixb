/**
 * Google upload protocol helpers.
 * (https://developers.google.com/workspace/drive/api/guides/manage-uploads)
 *
 * Drive exposes three upload types on the upload host
 * (`https://www.googleapis.com/upload/drive/v3`):
 *
 * - `media` — bytes only, no metadata in the same request.
 * - `multipart` — one `multipart/related` request: JSON metadata part first,
 *   media part second. Recommended up to 5 MiB.
 * - `resumable` — a session initiation (`POST`/`PATCH ...?uploadType=resumable`
 *   with `X-Upload-Content-Type` / `X-Upload-Content-Length`) returns a
 *   `Location` session URI; bytes follow in `PUT`s carrying
 *   `Content-Range: bytes start-end/total`. Non-final chunks must be multiples
 *   of 256 KiB. The server answers `308 Resume Incomplete` (plus a `Range`
 *   header for what it persisted) until the final chunk, which returns
 *   `200`/`201` with the file resource.
 *
 * Streams of unknown length take a one-shot streaming `PUT` to the session URI
 * (no `Content-Range`; Drive completes at stream end) — the same approach
 * Google's own clients use, since non-final `.../*` ranges are not documented
 * for Drive.
 */
import type { DriveUploadBody } from "./types/drive"

/** Multipart uploads are Google's recommended path up to 5 MiB. */
export const MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024

/** Resumable chunks must be a multiple of 256 KiB; 8 MiB bounds memory per chunk. */
export const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024

/** `308 Resume Incomplete` — chunk persisted (fully or partially), keep going. */
export const RESUME_INCOMPLETE = 308

/**
 * Resolve the upload size. Buffered bodies always use their real length —
 * `sizeBytes` is a hint for streams only, where the length is otherwise
 * unknowable without consuming the body.
 */
export function uploadSize(
  body: DriveUploadBody,
  sizeBytes: number | undefined
): number | undefined {
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return body.byteLength
  }
  if (body instanceof Blob) {
    return body.size
  }
  return sizeBytes
}

/** Buffer bodies are re-sendable and sliceable; streams are neither. */
export function isBufferedBody(body: DriveUploadBody): body is Uint8Array | ArrayBuffer | Blob {
  return !(body instanceof ReadableStream)
}

export async function toUint8Array(body: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body)
  }
  return new Uint8Array(await body.arrayBuffer())
}

/**
 * Build a `multipart/related` body: JSON metadata part, then the media part.
 * Only used up to `MULTIPART_LIMIT_BYTES`, so a single buffer is fine.
 */
export function buildMultipartBody(
  metadata: unknown,
  contentType: string,
  bytes: Uint8Array,
  boundary: string
): Uint8Array {
  const encoder = new TextEncoder()
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata ?? {})}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
  )
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)

  const body = new Uint8Array(head.length + bytes.length + tail.length)
  body.set(head, 0)
  body.set(bytes, head.length)
  body.set(tail, head.length + bytes.length)
  return body
}

export function createBoundary(): string {
  return `sixb_${crypto.randomUUID()}`
}

/**
 * Turn an upload body into an async iterable of re-sendable chunks of at most
 * `chunkBytes`, keeping memory bounded to roughly one chunk: buffer bodies are
 * sliced (Blobs lazily — `Bun.file(...)` never loads the whole file), and
 * streams are accumulated into full chunks so every non-final chunk honors the
 * 256 KiB multiple rule.
 */
export async function* chunkBody(
  body: DriveUploadBody,
  chunkBytes: number
): AsyncIterable<Uint8Array> {
  if (body instanceof Blob) {
    // Blob.slice is lazy in every runtime — no whole-file allocation.
    for (let offset = 0; offset < body.size; offset += chunkBytes) {
      yield new Uint8Array(await body.slice(offset, offset + chunkBytes).arrayBuffer())
    }
    return
  }

  if (isBufferedBody(body)) {
    const bytes = await toUint8Array(body)
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      yield bytes.subarray(offset, offset + chunkBytes)
    }
    return
  }

  let pending: Uint8Array[] = []
  let pendingBytes = 0

  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value.length === 0) {
        continue
      }
      pending.push(value)
      pendingBytes += value.length

      if (pendingBytes >= chunkBytes) {
        const merged = concat(pending, pendingBytes)
        pending = []
        pendingBytes = 0
        for (let offset = 0; offset < merged.length; offset += chunkBytes) {
          const chunk = merged.subarray(offset, offset + chunkBytes)
          if (offset + chunkBytes >= merged.length) {
            // Keep the tail buffered — it may yet merge with later reads. Copy
            // it when it is much smaller than `merged` so the view doesn't pin
            // the whole parent buffer until the next round.
            pending.push(merged.length > chunk.length ? chunk.slice() : chunk)
            pendingBytes = chunk.length
          } else {
            yield chunk
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (pendingBytes > 0) {
    yield concat(pending, pendingBytes)
  }
}

/** Parse a `Range: bytes=0-N` response header into the persisted byte count. */
export function persistedOffset(rangeHeader: string | null): number | null {
  const match = /^bytes=0-(\d+)$/.exec(rangeHeader ?? "")
  return match ? Number.parseInt(match[1] as string, 10) + 1 : null
}

function concat(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}
