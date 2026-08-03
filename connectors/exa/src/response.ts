import { ExaApiError } from "./errors"
import type { ExaCostDollars, ExaSearchResponse, ExaSearchResult, ExaSearchStatus } from "./types"

export function parseExaSearchResponse(value: unknown, status?: number): ExaSearchResponse {
  if (!isRecord(value)) throw malformed("the body must be an object", status)
  if (!Array.isArray(value.results)) throw malformed("results must be an array", status)

  for (const [index, result] of value.results.entries()) {
    assertSearchResult(result, index, status)
  }
  assertOptionalString(value, "requestId", status)
  assertOptionalString(value, "searchType", status)
  assertOptionalString(value, "resolvedSearchType", status)
  assertOptionalFiniteNumber(value, "searchTime", status)

  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses)) throw malformed("statuses must be an array", status)
    for (const [index, itemStatus] of value.statuses.entries()) {
      assertSearchStatus(itemStatus, index, status)
    }
  }

  if (value.costDollars !== undefined) {
    assertCostDollars(value.costDollars, status)
  }

  return value as unknown as ExaSearchResponse
}

function assertSearchResult(
  value: unknown,
  index: number,
  status?: number
): asserts value is ExaSearchResult {
  if (!isRecord(value)) throw malformed(`results[${index}] must be an object`, status)
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw malformed(`results[${index}].id must be a non-empty string`, status)
  }
  if (value.title !== null && typeof value.title !== "string") {
    throw malformed(`results[${index}].title must be a string or null`, status)
  }
  if (typeof value.url !== "string" || !isHttpUrl(value.url)) {
    throw malformed(`results[${index}].url must be an absolute HTTP(S) URL`, status)
  }
  assertOptionalNullableString(value, "publishedDate", `results[${index}]`, status)
  assertOptionalNullableString(value, "author", `results[${index}]`, status)
  assertOptionalString(value, "text", status, `results[${index}]`)
}

function assertSearchStatus(
  value: unknown,
  index: number,
  status?: number
): asserts value is ExaSearchStatus {
  if (!isRecord(value)) throw malformed(`statuses[${index}] must be an object`, status)
  for (const field of ["id", "status", "source"] as const) {
    if (typeof value[field] !== "string") {
      throw malformed(`statuses[${index}].${field} must be a string`, status)
    }
  }
}

function assertCostDollars(value: unknown, status?: number): asserts value is ExaCostDollars {
  if (!isRecord(value)) throw malformed("costDollars must be an object", status)
  if (!isNonNegativeFiniteNumber(value.total)) {
    throw malformed("costDollars.total must be a non-negative finite number", status)
  }
  for (const field of ["search", "contents"] as const) {
    const breakdown = value[field]
    if (breakdown === undefined) continue
    if (!isRecord(breakdown)) throw malformed(`costDollars.${field} must be an object`, status)
    for (const amount of Object.values(breakdown)) {
      if (!isNonNegativeFiniteNumber(amount)) {
        throw malformed(`costDollars.${field} values must be non-negative finite numbers`, status)
      }
    }
  }
}

function assertOptionalString(
  value: Record<string, unknown>,
  field: string,
  status?: number,
  prefix = "response"
): void {
  if (value[field] !== undefined && typeof value[field] !== "string") {
    throw malformed(`${prefix}.${field} must be a string`, status)
  }
}

function assertOptionalNullableString(
  value: Record<string, unknown>,
  field: string,
  prefix: string,
  status?: number
): void {
  const fieldValue = value[field]
  if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "string") {
    throw malformed(`${prefix}.${field} must be a string or null`, status)
  }
}

function assertOptionalFiniteNumber(
  value: Record<string, unknown>,
  field: string,
  status?: number
): void {
  if (value[field] !== undefined && !isNonNegativeFiniteNumber(value[field])) {
    throw malformed(`response.${field} must be a non-negative finite number`, status)
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function malformed(detail: string, status?: number): ExaApiError {
  return new ExaApiError(`[SixbExa] Exa search returned a malformed response: ${detail}.`, {
    status,
  })
}
