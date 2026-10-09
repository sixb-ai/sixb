/**
 * Request body limits for the API.
 *
 * Elysia parses a JSON or form body before the auth guard runs, so the server caps every body it
 * receives at `DEFAULT_REQUEST_BODY_LIMIT_BYTES` (`limitRequestBody`). A route that takes more,
 * such as a file upload, reads its own body with `readRequestBodyWithLimit`, whose limit replaces
 * that cap. Both apply the limit DURING streaming (not after buffering), so an oversized or
 * chunked/unknown-length body is rejected before it is fully read.
 */

/** The most a request body may be, unless the route reading it allows more. */
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  readonly name = "RequestBodyTooLargeError"

  constructor(
    readonly limitBytes: number,
    message = `Request body exceeds the ${limitBytes} byte limit.`
  ) {
    super(message)
  }
}

const requestBodyCaps = new WeakMap<Request, { lifted: boolean }>()

/**
 * Returns `request` with its body capped at `DEFAULT_REQUEST_BODY_LIMIT_BYTES`. Reading past the
 * cap fails with `RequestBodyTooLargeError`, which Elysia surfaces as a parse error.
 */
export function limitRequestBody(request: Request): Request {
  if (!request.body) {
    return request
  }

  const cap = { lifted: false }
  let total = 0
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (!cap.lifted && total > DEFAULT_REQUEST_BODY_LIMIT_BYTES) {
          controller.error(new RequestBodyTooLargeError(DEFAULT_REQUEST_BODY_LIMIT_BYTES))
          return
        }
        controller.enqueue(chunk)
      },
    })
  )
  const limited = new Request(request, { body, duplex: "half" } as RequestInit & {
    duplex: "half"
  })
  requestBodyCaps.set(limited, cap)
  return limited
}

/**
 * Reads a request body fully into memory, failing once it passes `limitBytes`. That limit
 * replaces the server's default cap for this request, so a route reading more than the default
 * must authenticate the caller first. The `content-length` header, when present, only provides an
 * early fast-path.
 */
export async function readRequestBodyWithLimit(
  request: Request,
  limitBytes: number,
  tooLargeMessage?: string
): Promise<Uint8Array<ArrayBuffer>> {
  // The loop below enforces `limitBytes` in place of the server's cap.
  const cap = requestBodyCaps.get(request)
  if (cap) {
    cap.lifted = true
  }

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
