import { parseRetryAfter } from "@sixb/connector-rest"

/**
 * A problem with how the connector was configured, raised before or instead of a request.
 *
 * Separate from `FleetioApiError` because it is never transient: a credential resolver that
 * returns nothing will keep returning nothing, so retrying it only delays the report.
 */
export class FleetioConfigurationError extends Error {
  readonly name = "FleetioConfigurationError"
}

/**
 * A non-2xx response from the Fleetio API.
 *
 * Fleetio reports failures in three shapes: `{ "errors": { "field": ["message"] } }` for 400 and
 * 422, RFC 7807 problem details for 401, 403, 404 and 500, and `{ "error": "..." }` for 429. A 403
 * can also arrive with an empty body.
 */
export class FleetioApiError extends Error {
  readonly name = "FleetioApiError"
  readonly headers: Headers
  readonly retryAfterMs: number | null
  /** Per-field messages from a 400 or 422, keyed by field name. */
  readonly validationErrors: Readonly<Record<string, readonly string[]>> | null

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    super(formatFleetioApiError(status, responseBody))
    this.headers = new Headers(headers)
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
    this.validationErrors = extractValidationErrors(responseBody)
  }
}

function formatFleetioApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbFleetio] Fleetio API request failed with ${status}: ${message}`
    : `[SixbFleetio] Fleetio API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null
  }

  if (!isRecord(value)) {
    return null
  }

  const validation = extractValidationErrors(value)
  if (validation) {
    return Object.entries(validation)
      .map(([field, messages]) => `${field}: ${messages.join(", ")}`)
      .join("; ")
  }

  if (typeof value.error === "string" && value.error.trim()) {
    return value.error
  }

  const title = typeof value.title === "string" ? value.title.trim() : ""
  const detail = typeof value.detail === "string" ? value.detail.trim() : ""
  return [title, detail].filter(Boolean).join(": ") || null
}

function extractValidationErrors(
  value: unknown
): Readonly<Record<string, readonly string[]>> | null {
  if (!isRecord(value) || !isRecord(value.errors)) {
    return null
  }

  const errors: Record<string, readonly string[]> = {}
  for (const [field, messages] of Object.entries(value.errors)) {
    errors[field] = Array.isArray(messages) ? messages.map(String) : [String(messages)]
  }

  return Object.keys(errors).length > 0 ? errors : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
