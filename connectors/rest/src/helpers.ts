import type { RestQueryOptions, RestQueryParams, RestQueryValue, RestRetryContext } from "./types"

/** Add typed query parameters while keeping a relative path relative to the configured base URL. */
export function withQuery(
  path: string,
  query?: RestQueryParams,
  options: RestQueryOptions = {}
): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  if (!query) return normalizedPath

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(params, key, value, options)
  }

  const queryString = params.toString()
  return queryString ? `${normalizedPath}?${queryString}` : normalizedPath
}

/** Read an empty, JSON, or text response body without losing provider error detail. */
export async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined

  const text = await response.text()
  if (!text) return undefined

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Parse both delta-seconds and HTTP-date forms of Retry-After. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1000
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : Math.max(timestamp - now, 0)
}

/** Conservative default: retry only idempotent transient failures, never caller aborts. */
export function shouldRetryRestRequest(context: RestRetryContext): boolean {
  if (!context.idempotent || isAbortError(context.error)) return false
  if (context.error) return true

  const status = context.response?.status
  return status === 429 || (status !== undefined && status >= 500)
}

/** Retry-After when available, otherwise capped exponential backoff. */
export function restRetryDelayMs(context: RestRetryContext): number {
  return (
    parseRetryAfter(context.response?.headers.get("retry-after") ?? null) ??
    Math.min(1000 * 2 ** context.attempt, 30_000)
  )
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function appendQueryValue(
  params: URLSearchParams,
  key: string,
  value: RestQueryValue,
  options: RestQueryOptions
): void {
  if (value === undefined || value === null || (options.omitEmptyString && value === "")) return

  if (Array.isArray(value)) {
    if (options.arrayFormat === "comma") {
      params.set(key, value.map(String).join(","))
      return
    }
    for (const entry of value) params.append(key, String(entry))
    return
  }

  params.set(key, String(value))
}
