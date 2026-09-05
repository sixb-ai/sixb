import { findObjectQueryStructureIssue } from "@sixb/core/internal/query"
import { RequestBodyTooLargeError, readRequestBodyWithLimit } from "./request-body"

/** Hard transport ceiling for object-query control payloads. */
export const OBJECT_QUERY_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024

class InvalidObjectQueryRequestBodyError extends Error {
  readonly name = "InvalidObjectQueryRequestBodyError"
}

/** Parse and structurally bound an object-query request before Elysia reaches recursive Zod. */
export async function parseBoundedObjectQueryBody(context: {
  readonly request: Request
}): Promise<unknown> {
  const bytes = await readBoundedBody(context.request)
  if (!hasJsonContentType(context.request)) {
    // Elysia parses text/plain as text. The object-query schema will reject it; importantly, a
    // JSON-looking string must not gain JSON semantics merely because this route has a custom cap.
    return new TextDecoder().decode(bytes)
  }

  const body = parseJsonBody(bytes)
  if (!isRecord(body)) return body

  const found = findObjectQueryStructureIssue(body.query)
  if (found) throw invalid(`${found.message}.`)
  return body
}

export function mapObjectQueryRequestParseError(context: {
  readonly error: unknown
  readonly set: { status?: number | string }
}): { error: string } | undefined {
  const tooLarge = findCause(context.error, RequestBodyTooLargeError)
  if (tooLarge) {
    context.set.status = 413
    return { error: tooLarge.message }
  }

  const invalidBody = findCause(context.error, InvalidObjectQueryRequestBodyError)
  if (invalidBody) {
    context.set.status = 400
    return { error: invalidBody.message }
  }

  return undefined
}

function readBoundedBody(request: Request): Promise<Uint8Array> {
  return readRequestBodyWithLimit(
    request,
    OBJECT_QUERY_REQUEST_BODY_LIMIT_BYTES,
    `[SixbServer] Object query request body exceeds the ${OBJECT_QUERY_REQUEST_BODY_LIMIT_BYTES}-byte limit.`
  )
}

function parseJsonBody(bytes: Uint8Array): unknown {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(json) as unknown
  } catch {
    throw invalid("Object query request body must contain valid UTF-8 JSON.")
  }
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")
  if (!contentType) return false
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
}

function findCause<TError extends Error>(
  error: unknown,
  errorType: new (...args: never[]) => TError
): TError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof errorType) return current
    current = (current as { cause?: unknown } | null | undefined)?.cause
  }
  return undefined
}

function invalid(message: string): InvalidObjectQueryRequestBodyError {
  return new InvalidObjectQueryRequestBodyError(`[SixbServer] ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
