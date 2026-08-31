import { isRecord } from "./guards"

/**
 * Raised when a Google API request fails. Parses the standard Google error
 * envelope (`{ error: { code, message, status, ... } }`) shared by every
 * Google API surface.
 */
export class GoogleApiError extends Error {
  readonly name = "GoogleApiError"

  constructor(
    readonly status: number,
    readonly responseBody: unknown
  ) {
    super(formatGoogleApiError(status, responseBody))
  }
}

/** Raised when resolving or refreshing Google authentication credentials fails. */
export class GoogleAuthError extends Error {
  readonly name = "GoogleAuthError"

  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbGoogle] ${message}`, options)
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
