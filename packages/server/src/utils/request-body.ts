/**
 * Request body limits for the API.
 *
 * Elysia parses a JSON or form body before the auth guard runs, so the server caps every body it
 * receives at `DEFAULT_REQUEST_BODY_LIMIT_BYTES` (`limitRequestBody`). A route that takes more,
 * such as a file upload, reads its own body with `readRequestBodyWithLimit`, or hands it on with
 * `streamRequestBodyWithLimit`, whose limit replaces that cap. Each applies its limit DURING
 * streaming (not after buffering), so an oversized or chunked/unknown-length body is rejected
 * before it is fully read.
 *
 * Bun's own limit is the largest any route takes, a staged upload's, so a body declared past the
 * cap is refused up front (`declaredBodyTooLarge`) unless its route is one of
 * `LARGER_BODY_ROUTES`.
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

/**
 * The routes that read a body past the cap, each within its own limit once it knows the caller.
 * A path's `:name` segment matches any one segment, and a trailing `*` whatever follows.
 */
const LARGER_BODY_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  // A file in one request, and a staged upload's content.
  { method: "POST", path: "/api/files" },
  { method: "PUT", path: "/api/files/uploads/:uploadId/content" },
  // Minutes of base64 dictation.
  { method: "POST", path: "/api/models/audio/transcriptions" },
  // A webhook's body, within the limit its definition sets, whatever its method.
  { method: "*", path: "/api/webhooks/:connectorId/:webhookId" },
  // A runner's calls to its run's session.
  { method: "*", path: "/api/agent-runs/:runId/session/*" },
]

/**
 * Why `request` is refused before any of its body is read: it declares a body past the cap, and
 * its route never reads one that large. Undefined when it may go on.
 */
export function declaredBodyTooLarge(request: Request): RequestBodyTooLargeError | undefined {
  const declared = Number(request.headers.get("content-length"))
  if (!Number.isSafeInteger(declared) || declared <= DEFAULT_REQUEST_BODY_LIMIT_BYTES) {
    return undefined
  }

  const method = request.method.toUpperCase()
  const segments = new URL(request.url).pathname.split("/")
  const readsMore = LARGER_BODY_ROUTES.some(
    (route) =>
      (route.method === "*" || route.method === method) && matchesSegments(segments, route.path)
  )
  return readsMore ? undefined : new RequestBodyTooLargeError(DEFAULT_REQUEST_BODY_LIMIT_BYTES)
}

function matchesSegments(segments: readonly string[], pattern: string): boolean {
  const expected = pattern.split("/")
  for (const [index, segment] of expected.entries()) {
    const actual = segments[index]
    if (segment === "*") return actual !== undefined && actual !== ""
    if (actual === undefined) return false
    if (segment.startsWith(":") ? actual === "" : actual !== segment) return false
  }
  return segments.length === expected.length
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
 * Lifts the server's cap for a request whose handler reads the body itself, within its own limit,
 * once it has authenticated the caller: a runner's run session (see serveAgentRunSession).
 */
export function liftRequestBodyCap(request: Request): void {
  const cap = requestBodyCaps.get(request)
  if (cap) cap.lifted = true
}

/**
 * A request body as it streams in, failing once it passes `limitBytes`: for a route that hands the
 * bytes on, such as to blob storage, without holding them. Like {@link readRequestBodyWithLimit},
 * its limit replaces the server's cap, so the route must authenticate the caller first.
 */
export function streamRequestBodyWithLimit(
  request: Request,
  limitBytes: number,
  tooLargeMessage?: string
): ReadableStream<Uint8Array> {
  liftRequestBodyCap(request)

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isSafeInteger(declared) && declared > limitBytes) {
      throw new RequestBodyTooLargeError(limitBytes, tooLargeMessage)
    }
  }

  let total = 0
  return (request.body ?? new Blob([]).stream()).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > limitBytes) {
          controller.error(new RequestBodyTooLargeError(limitBytes, tooLargeMessage))
          return
        }
        controller.enqueue(chunk)
      },
    })
  )
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
  liftRequestBodyCap(request)

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
