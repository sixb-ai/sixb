export class UnipileApiError extends Error {
  readonly name = "UnipileApiError"
  readonly headers: Headers
  readonly retryAfterMs: number | null
  readonly requestId: string | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(formatUnipileApiError(status, responseBody))
    this.headers = new Headers(headers)
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
    this.requestId =
      this.headers.get("x-request-id") ?? this.headers.get("unipile-request-id") ?? null
  }
}

function formatUnipileApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbUnipile] Unipile API request failed with ${status}: ${message}`
    : `[SixbUnipile] Unipile API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value
  }
  if (!isRecord(value)) {
    return null
  }

  for (const candidate of [value.detail, value.message, value.title, value.error, value.code]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }

  if (Array.isArray(value.errors) && value.errors.length > 0) {
    const first = value.errors[0]
    if (typeof first === "string") {
      return first
    }
    if (isRecord(first) && typeof first.message === "string") {
      return first.message
    }
  }

  return null
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null
  }

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
