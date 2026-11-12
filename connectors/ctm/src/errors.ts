import { parseRetryAfter } from "@sixb/connector-rest"
import { isRecord } from "./validation"

/**
 * A problem with how the connector was configured, raised before or instead of a request.
 *
 * Separate from `CtmApiError` because it is never transient: a credential resolver that returns
 * nothing will keep returning nothing, so retrying it only delays the report.
 */
export class CtmConfigurationError extends Error {
  readonly name = "CtmConfigurationError"
}

/**
 * A non-2xx response from the CTM API.
 *
 * CTM documents no error format. Its routes answer with a string, `{ "error": "..." }`,
 * `{ "message": "..." }`, `{ "errors": [...] }` or flags such as `{ "authentication": "failed" }`,
 * so the message is read from whichever is there and the body is kept as it came.
 */
export class CtmApiError extends Error {
  readonly name = "CtmApiError"
  readonly headers: Headers
  readonly retryAfterMs: number | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(formatCtmApiError(status, responseBody))
    this.headers = new Headers(headers)
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
  }
}

function formatCtmApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)

  return message
    ? `[SixbCtm] CTM API request failed with ${status}: ${message}`
    : `[SixbCtm] CTM API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null
  }

  if (!isRecord(value)) {
    return null
  }

  for (const field of ["error", "message", "reason"]) {
    const text = value[field]
    if (typeof text === "string" && text.trim()) {
      return text.trim()
    }
  }

  return formatErrors(value.errors) ?? formatFlags(value)
}

/** CTM answers a rejected key with `{ "authentication": "failed" }`: read it as `authentication: failed`. */
function formatFlags(value: Record<string, unknown>): string | null {
  const flags = Object.entries(value).filter(([, detail]) => typeof detail === "string" && detail)

  return flags.map(([field, detail]) => `${field}: ${detail}`).join("; ") || null
}

function formatErrors(errors: unknown): string | null {
  if (Array.isArray(errors)) {
    return errors.map(String).join("; ") || null
  }

  if (isRecord(errors)) {
    const messages = Object.entries(errors).map(([field, detail]) => {
      return `${field}: ${Array.isArray(detail) ? detail.join(", ") : String(detail)}`
    })

    return messages.join("; ") || null
  }

  return null
}
