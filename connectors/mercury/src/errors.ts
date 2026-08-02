import { connectorCodeForStatus, SixbProviderError } from "@sixb/core/errors"
export class MercuryApiError extends SixbProviderError {
  override readonly name = "MercuryApiError"
  readonly headers: Headers
  readonly retryAfterMs: number | null
  readonly requestId: string | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(connectorCodeForStatus(status), formatMercuryApiError(status, responseBody), {
      details: { status },
    })
    this.headers = new Headers(headers)
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
    this.requestId =
      this.headers.get("x-request-id") ?? this.headers.get("mercury-request-id") ?? null
  }
}

function formatMercuryApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbMercury] Mercury API request failed with ${status}: ${message}`
    : `[SixbMercury] Mercury API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  // Mercury returns validation failures as `errors.message`, and other failures as a bare
  // `error` or `message` string.
  const errors = value.errors
  if (isRecord(errors) && typeof errors.message === "string" && errors.message.trim()) {
    return errors.message
  }

  for (const candidate of [value.message, value.error]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
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
