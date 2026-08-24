import { isRecord } from "../guards"
import type { GoogleAdsErrorDetail, GoogleAdsFailure } from "./types"

export class GoogleAdsConfigurationError extends Error {
  readonly name = "GoogleAdsConfigurationError"

  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbGoogleAds] ${message}`, options)
  }
}

/** A successful response whose JSON shape does not match the Google Ads REST contract. */
export class GoogleAdsProtocolError extends Error {
  readonly name = "GoogleAdsProtocolError"

  constructor(
    message: string,
    readonly responseBody: unknown
  ) {
    super(`[SixbGoogleAds] ${message}`)
  }
}

/** A non-2xx Google Ads response, including its granular failure details and request ID. */
export class GoogleAdsApiError extends Error {
  readonly name = "GoogleAdsApiError"
  readonly requestId?: string
  readonly failures: readonly GoogleAdsFailure[]
  readonly errors: readonly GoogleAdsErrorDetail[]
  readonly responseHeaders: Headers

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    responseHeaders: HeadersInit = {}
  ) {
    const failures = extractFailures(responseBody)
    const errors = failures.flatMap((failure) => failure.errors ?? [])
    const headers = new Headers(responseHeaders)
    const requestId =
      headers.get("request-id") ??
      headers.get("google-ads-request-id") ??
      failures.find((failure) => failure.requestId)?.requestId
    super(formatGoogleAdsApiError(status, responseBody, errors, requestId))
    this.failures = failures
    this.errors = errors
    this.requestId = requestId
    this.responseHeaders = headers
  }
}

function extractFailures(responseBody: unknown): readonly GoogleAdsFailure[] {
  if (!isRecord(responseBody) || !isRecord(responseBody.error)) {
    return []
  }
  const details = responseBody.error.details
  if (!Array.isArray(details)) {
    return []
  }
  return details.filter(isGoogleAdsFailure)
}

function formatGoogleAdsApiError(
  status: number,
  responseBody: unknown,
  errors: readonly GoogleAdsErrorDetail[],
  requestId: string | undefined
): string {
  const detail = errors.find((error) => error.message)
  const code = detail?.errorCode ? firstStringValue(detail.errorCode) : undefined
  const message = detail?.message ?? outerMessage(responseBody)
  const description = [code, message].filter(Boolean).join(": ")
  const request = requestId ? ` (request ID: ${requestId})` : ""
  return description
    ? `[SixbGoogleAds] Google Ads API request failed with ${status}: ${description}${request}`
    : `[SixbGoogleAds] Google Ads API request failed with ${status}.${request}`
}

function outerMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return typeof value === "string" && value.trim() ? value : undefined
  }
  return typeof value.error.message === "string" && value.error.message.trim()
    ? value.error.message
    : undefined
}

function firstStringValue(value: Readonly<Record<string, string>>): string | undefined {
  return Object.values(value).find((candidate) => typeof candidate === "string" && candidate)
}

function isGoogleAdsFailure(value: unknown): value is GoogleAdsFailure {
  if (!isRecord(value)) {
    return false
  }
  const type = value["@type"]
  return (
    (typeof type === "string" && type.endsWith(".GoogleAdsFailure")) || Array.isArray(value.errors)
  )
}
