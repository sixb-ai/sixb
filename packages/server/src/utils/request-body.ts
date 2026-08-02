import { SixbValidationError } from "@sixb/core/errors"

/**
 * Reads a request body fully into memory while enforcing a hard byte ceiling.
 *
 * The cap is applied DURING streaming (not after buffering), so an oversized or
 * chunked/unknown-length body is rejected before it is fully read — the
 * `content-length` header, when present, only provides an early fast-path. This
 * is the single bounded-reader used by request handlers that need the raw bytes.
 */
export class RequestBodyTooLargeError extends SixbValidationError {
  override readonly name = "RequestBodyTooLargeError"

  constructor(
    readonly limitBytes: number,
    message = `Request body exceeds the ${limitBytes} byte limit.`
  ) {
    super("runtime.payload_too_large", message, { details: { limitBytes } })
  }
}

export async function readRequestBodyWithLimit(
  request: Request,
  limitBytes: number,
  tooLargeMessage?: string
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isSafeInteger(declared) && declared > limitBytes) {
      throw new RequestBodyTooLargeError(limitBytes, tooLargeMessage)
    }
  }

  if (!request.body) {
    return new Uint8Array(0)
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    total += value.byteLength
    if (total > limitBytes) {
      await reader.cancel()
      throw new RequestBodyTooLargeError(limitBytes, tooLargeMessage)
    }

    chunks.push(value)
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
