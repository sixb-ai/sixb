import { connectorCodeForStatus, type SixbErrorOptions, SixbProviderError } from "@sixb/core/errors"
/**
 * Raised when a Google API request fails. Parses the standard Google error
 * envelope (`{ error: { code, message, status, ... } }`) shared by every
 * Google API surface.
 */
export class GoogleApiError extends SixbProviderError {
  override readonly name = "GoogleApiError"

  constructor(
    readonly status: number,
    readonly responseBody: unknown
  ) {
    super(connectorCodeForStatus(status), formatGoogleApiError(status, responseBody), {
      details: { status },
    })
  }
}

/** Raised when resolving or refreshing Google authentication credentials fails. */
export class GoogleAuthError extends SixbProviderError {
  override readonly name = "GoogleAuthError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("connector.unauthorized", `[SixbGoogle] ${message}`, options)
  }
}

function formatGoogleApiError(status: number, responseBody: unknown): string {
  const message = extractMessage(responseBody)
  return message
    ? `[SixbGoogle] Google API request failed with ${status}: ${message}`
    : `[SixbGoogle] Google API request failed with ${status}.`
}

function extractMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null
  }

  if (!isRecord(value)) {
    return null
  }

  // Standard envelope: { error: { message, status } } or OAuth: { error, error_description }.
  const error = value.error
  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
    return error.message
  }

  if (typeof error === "string" && error.trim()) {
    const description = value.error_description
    return typeof description === "string" && description.trim()
      ? `${error}: ${description}`
      : error
  }

  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
