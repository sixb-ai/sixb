import { parseRetryAfter } from "@sixb/connector-rest"

export class PennylaneApiError extends Error {
  readonly name = "PennylaneApiError"
  readonly headers: Headers
  readonly retryAfterMs: number | null
  readonly requestId: string | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(formatPennylaneApiError(status, responseBody))
    this.headers = new Headers(headers)
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
    this.requestId =
      this.headers.get("x-request-id") ?? this.headers.get("x-correlation-id") ?? null
  }
}

function formatPennylaneApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbPennylane] Pennylane API request failed with ${status}: ${message}`
    : `[SixbPennylane] Pennylane API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  const error = value.error
  const message = value.message
  if (typeof error === "string" && error.trim() && typeof message === "string" && message.trim()) {
    return `${error}: ${message}`
  }

  for (const candidate of [message, error]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
