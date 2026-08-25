import type { GoogleAuthOptions } from "../auth"
import { GoogleAdsConfigurationError } from "./errors"

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords"

export function assertGoogleAdsScope(auth: GoogleAuthOptions): void {
  if ("scopes" in auth && !auth.scopes.some((scope) => scope.trim() === GOOGLE_ADS_SCOPE)) {
    throw new GoogleAdsConfigurationError(
      `auth.scopes must include the Google Ads scope "${GOOGLE_ADS_SCOPE}".`
    )
  }
}

/** Accept the hyphenated UI form, but always send Google's required 10 digits. */
export function normalizeCustomerId(value: string, field: string): string {
  const trimmed = value.trim()
  const withoutResourcePrefix = trimmed.startsWith("customers/")
    ? trimmed.slice("customers/".length)
    : trimmed
  const normalized = withoutResourcePrefix.replaceAll("-", "")
  if (!/^\d{10}$/.test(normalized)) {
    throw new GoogleAdsConfigurationError(
      `${field} must be a 10-digit Google Ads customer ID (hyphens are optional).`
    )
  }
  return normalized
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new GoogleAdsConfigurationError(`${field} must not be empty.`)
  }
}

export function assertMajorApiVersion(value: string): void {
  if (!/^v[1-9]\d*$/.test(value)) {
    throw new GoogleAdsConfigurationError(
      "apiVersion must be a major endpoint such as v25; minor releases use the same endpoint."
    )
  }
}

export function assertGaql(query: string): void {
  if (!query.trim()) {
    throw new GoogleAdsConfigurationError("GAQL query must not be empty.")
  }
}

export function assertOptionalPageToken(pageToken: string | undefined): void {
  if (pageToken !== undefined && !pageToken.trim()) {
    throw new GoogleAdsConfigurationError("pageToken must not be empty when provided.")
  }
}

export function assertIsoDateRange(startDate: string, endDate: string): void {
  assertIsoDate(startDate, "startDate")
  assertIsoDate(endDate, "endDate")
  if (startDate > endDate) {
    throw new GoogleAdsConfigurationError("startDate must not be after endDate.")
  }
}

function assertIsoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new GoogleAdsConfigurationError(`${field} must use YYYY-MM-DD format.`)
  }
  const resolved = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(resolved.getTime()) || resolved.toISOString().slice(0, 10) !== value) {
    throw new GoogleAdsConfigurationError(`${field} must be a valid calendar date.`)
  }
}
