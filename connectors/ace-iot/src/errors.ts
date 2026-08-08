/**
 * A problem with how the connector was configured, raised before or instead of a request.
 *
 * Separate from `AceIotApiError` because it is never transient: an API key resolver that returns
 * nothing will keep returning nothing, so retrying it only delays the report. A resolver that
 * throws for its own reasons — a token endpoint timing out, say — raises that error instead and is
 * retried like any other read failure.
 */
export class AceIotConfigurationError extends Error {
  readonly name = "AceIotConfigurationError"
}

/**
 * A non-2xx response from the ACE API.
 *
 * ACE reports failures in two shapes: a bare `{"message": "..."}`, and Flask-RESTX request
 * validation as `{"message": "Input payload validation failed", "errors": {"per_page": "..."}}`.
 * Both are surfaced — the per-field detail through `validationErrors`.
 */
export class AceIotApiError extends Error {
  readonly name = "AceIotApiError"
  readonly headers: Headers
  readonly retryAfterMs: number | null
  /** Per-field validation detail from a 400, keyed by parameter name. */
  readonly validationErrors: Readonly<Record<string, string>> | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(formatAceIotApiError(status, responseBody))
    this.headers = new Headers(headers)
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
    this.validationErrors = extractValidationErrors(responseBody)
  }
}

/**
 * ACE answers an invalid API key with a 500 carrying Flask's generic handler message, not a 401.
 * A caller staring at "An unhandled exception occurred." has no way to guess that, so say it.
 */
const GENERIC_SERVER_ERROR = "An unhandled exception occurred."
const BAD_KEY_HINT = " ACE also returns this when the API key is invalid."

function formatAceIotApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  const detail = formatValidationErrors(extractValidationErrors(responseBody))
  const hint = status === 500 && message === GENERIC_SERVER_ERROR ? BAD_KEY_HINT : ""

  if (!message) {
    return `[SixbAceIot] ACE API request failed with ${status}.${hint}`
  }

  return `[SixbAceIot] ACE API request failed with ${status}: ${message}${detail}${hint}`
}

function formatValidationErrors(errors: Readonly<Record<string, string>> | null): string {
  if (!errors) {
    return ""
  }

  const entries = Object.entries(errors).map(([field, detail]) => `${field}: ${detail}`)
  return entries.length ? ` (${entries.join("; ")})` : ""
}

function extractValidationErrors(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value) || !isRecord(value.errors)) {
    return null
  }

  const errors: Record<string, string> = {}
  for (const [field, detail] of Object.entries(value.errors)) {
    errors[field] = typeof detail === "string" ? detail : JSON.stringify(detail)
  }

  return Object.keys(errors).length ? errors : null
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  const message = value.message
  return typeof message === "string" && message.trim() ? message : null
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
