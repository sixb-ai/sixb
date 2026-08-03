import { ExaApiError } from "./errors"
import type {
  ExaContentsResponse,
  ExaContentsResult,
  ExaContentsStatus,
  ExaCostDollars,
  ExaSearchResponse,
  ExaSearchResult,
  ExaSearchStatus,
} from "./types"

export function parseExaSearchResponse(value: unknown, status?: number): ExaSearchResponse {
  if (!isRecord(value)) throw malformed("search", "the body must be an object", status)
  if (!Array.isArray(value.results)) throw malformed("search", "results must be an array", status)

  for (const [index, result] of value.results.entries()) {
    assertDocumentResult(result, index, "search", status)
  }
  assertOptionalString(value, "requestId", "search", status)
  assertOptionalString(value, "searchType", "search", status)
  assertOptionalString(value, "resolvedSearchType", "search", status)
  assertOptionalFiniteNumber(value, "searchTime", status)

  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses)) {
      throw malformed("search", "statuses must be an array", status)
    }
    for (const [index, itemStatus] of value.statuses.entries()) {
      assertSearchStatus(itemStatus, index, status)
    }
  }

  if (value.costDollars !== undefined) {
    assertCostDollars(value.costDollars, "search", status)
  }

  return value as unknown as ExaSearchResponse
}

export function parseExaContentsResponse(value: unknown, status?: number): ExaContentsResponse {
  if (!isRecord(value)) throw malformed("contents", "the body must be an object", status)
  if (!Array.isArray(value.results)) {
    throw malformed("contents", "results must be an array", status)
  }

  for (const [index, result] of value.results.entries()) {
    assertDocumentResult(result, index, "contents", status)
  }
  assertOptionalString(value, "requestId", "contents", status)

  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses)) {
      throw malformed("contents", "statuses must be an array", status)
    }
    for (const [index, itemStatus] of value.statuses.entries()) {
      assertContentsStatus(itemStatus, index, status)
    }
  }

  if (value.costDollars !== undefined) {
    assertCostDollars(value.costDollars, "contents", status)
  }

  return value as unknown as ExaContentsResponse
}

function assertDocumentResult(
  value: unknown,
  index: number,
  operation: "search" | "contents",
  status?: number
): asserts value is ExaSearchResult | ExaContentsResult {
  if (!isRecord(value)) {
    throw malformed(operation, `results[${index}] must be an object`, status)
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw malformed(operation, `results[${index}].id must be a non-empty string`, status)
  }
  if (value.title !== null && typeof value.title !== "string") {
    throw malformed(operation, `results[${index}].title must be a string or null`, status)
  }
  if (typeof value.url !== "string" || !isHttpUrl(value.url)) {
    throw malformed(operation, `results[${index}].url must be an absolute HTTP(S) URL`, status)
  }
  assertOptionalNullableString(value, "publishedDate", `results[${index}]`, operation, status)
  assertOptionalNullableString(value, "author", `results[${index}]`, operation, status)
  assertOptionalString(value, "text", operation, status, `results[${index}]`)
}

function assertSearchStatus(
  value: unknown,
  index: number,
  status?: number
): asserts value is ExaSearchStatus {
  if (!isRecord(value)) {
    throw malformed("search", `statuses[${index}] must be an object`, status)
  }
  for (const field of ["id", "status", "source"] as const) {
    if (typeof value[field] !== "string") {
      throw malformed("search", `statuses[${index}].${field} must be a string`, status)
    }
  }
}

function assertContentsStatus(
  value: unknown,
  index: number,
  status?: number
): asserts value is ExaContentsStatus {
  if (!isRecord(value)) {
    throw malformed("contents", `statuses[${index}] must be an object`, status)
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw malformed("contents", `statuses[${index}].id must be a non-empty string`, status)
  }
  if (typeof value.status !== "string" || !value.status.trim()) {
    throw malformed("contents", `statuses[${index}].status must be a non-empty string`, status)
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw malformed("contents", `statuses[${index}].source must be a string`, status)
  }
  if (value.error !== undefined) {
    if (!isRecord(value.error)) {
      throw malformed("contents", `statuses[${index}].error must be an object`, status)
    }
    if (typeof value.error.tag !== "string" || !value.error.tag.trim()) {
      throw malformed("contents", `statuses[${index}].error.tag must be a non-empty string`, status)
    }
    const httpStatusCode = value.error.httpStatusCode
    if (
      httpStatusCode !== undefined &&
      httpStatusCode !== null &&
      !Number.isInteger(httpStatusCode)
    ) {
      throw malformed(
        "contents",
        `statuses[${index}].error.httpStatusCode must be an integer or null`,
        status
      )
    }
  }
}

function assertCostDollars(
  value: unknown,
  operation: "search" | "contents",
  status?: number
): asserts value is ExaCostDollars {
  if (!isRecord(value)) throw malformed(operation, "costDollars must be an object", status)
  if (!isNonNegativeFiniteNumber(value.total)) {
    throw malformed(operation, "costDollars.total must be a non-negative finite number", status)
  }
  for (const field of ["search", "contents"] as const) {
    const breakdown = value[field]
    if (breakdown === undefined) continue
    if (!isRecord(breakdown)) {
      throw malformed(operation, `costDollars.${field} must be an object`, status)
    }
    for (const amount of Object.values(breakdown)) {
      if (!isNonNegativeFiniteNumber(amount)) {
        throw malformed(
          operation,
          `costDollars.${field} values must be non-negative finite numbers`,
          status
        )
      }
    }
  }
}

function assertOptionalString(
  value: Record<string, unknown>,
  field: string,
  operation: "search" | "contents",
  status?: number,
  prefix = "response"
): void {
  if (value[field] !== undefined && typeof value[field] !== "string") {
    throw malformed(operation, `${prefix}.${field} must be a string`, status)
  }
}

function assertOptionalNullableString(
  value: Record<string, unknown>,
  field: string,
  prefix: string,
  operation: "search" | "contents",
  status?: number
): void {
  const fieldValue = value[field]
  if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "string") {
    throw malformed(operation, `${prefix}.${field} must be a string or null`, status)
  }
}

function assertOptionalFiniteNumber(
  value: Record<string, unknown>,
  field: string,
  status?: number
): void {
  if (value[field] !== undefined && !isNonNegativeFiniteNumber(value[field])) {
    throw malformed("search", `response.${field} must be a non-negative finite number`, status)
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

function malformed(operation: "search" | "contents", detail: string, status?: number): ExaApiError {
  return new ExaApiError(`[SixbExa] Exa ${operation} returned a malformed response: ${detail}.`, {
    status,
  })
}
