export class LinkedinApiError extends Error {
  readonly name = "LinkedinApiError"
  readonly headers: Headers
  readonly requestId: string | null
  readonly retryAfterMs: number | null
  readonly serviceErrorCode: string | number | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(formatError(status, responseBody))
    this.headers = new Headers(headers)
    this.requestId = this.headers.get("x-li-uuid") ?? this.headers.get("x-restli-id") ?? null
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
    this.serviceErrorCode = extractServiceErrorCode(responseBody)
  }
}

function extractServiceErrorCode(value: unknown): string | number | null {
  if (!isRecord(value)) return null
  return typeof value.serviceErrorCode === "string" || typeof value.serviceErrorCode === "number"
    ? value.serviceErrorCode
    : null
}

/** Internal marker for local validation failures that must never be retried as network errors. */
export class LinkedinConfigurationError extends Error {
  readonly name = "LinkedinConfigurationError"
}

function formatError(status: number, body: unknown): string {
  const message = extractMessage(body)
  return message
    ? `[SixbLinkedin] LinkedIn API request failed with ${status}: ${message}`
    : `[SixbLinkedin] LinkedIn API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value
  }
  if (!isRecord(value)) {
    return null
  }

  for (const candidate of [value.message, value.error, value.errorMessage]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }
  return null
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1000
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : Math.max(timestamp - Date.now(), 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
