export const MAX_BATCH_SIZE = 100
export const MAX_SEARCH_LIMIT = 100
export const MAX_SEARCH_OFFSET = 10_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function assertObject(value: unknown, field: string): void {
  if (!isRecord(value)) throw new Error(`[SixbFullEnrich] ${field} must be an object.`)
}

export function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbFullEnrich] ${field} must be a non-empty string.`)
  }
}

export function assertInteger(value: number, field: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`[SixbFullEnrich] ${field} must be an integer from ${min} to ${max}.`)
  }
}

export function assertBatch(value: readonly unknown[], field: string): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_SIZE) {
    throw new Error(`[SixbFullEnrich] ${field} must contain from 1 to ${MAX_BATCH_SIZE} entries.`)
  }
}

export function assertHttpUrl(value: string | undefined, field: string): void {
  if (value === undefined) return
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`[SixbFullEnrich] ${field} must be an absolute HTTP(S) URL.`)
  }
}

/** FullEnrich rejects non-string custom values, so fail before the whole batch is refused. */
export function assertCustomFields(value: unknown, field: string): void {
  if (value === undefined) return
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`[SixbFullEnrich] ${field} must be an object with string values.`)
  }
}

/** The envelope shared by enrichment and reverse email lookup starts. */
export function assertJobRequest(
  request: {
    readonly name: string
    readonly webhook_url?: string
    readonly webhook_events?: { readonly contact_finished?: string }
    readonly data: readonly unknown[]
  },
  operation: string
): void {
  assertObject(request, `${operation} request`)
  assertNonEmpty(request.name, "name")
  assertHttpUrl(request.webhook_url, "webhook_url")
  if (request.webhook_events !== undefined) {
    assertObject(request.webhook_events, "webhook_events")
    assertHttpUrl(request.webhook_events.contact_finished, "webhook_events.contact_finished")
  }
  assertBatch(request.data, "data")
  for (const [index, entry] of request.data.entries()) {
    assertObject(entry, `data[${index}]`)
    assertCustomFields((entry as { custom?: unknown }).custom, `data[${index}].custom`)
  }
}

export function assertSearchPage(request: {
  readonly offset?: number
  readonly limit?: number
  readonly search_after?: string
}): void {
  if (request.limit !== undefined) assertInteger(request.limit, "limit", 1, MAX_SEARCH_LIMIT)
  if (request.offset !== undefined) {
    assertInteger(request.offset, "offset", 0, MAX_SEARCH_OFFSET)
  }
  if (request.search_after !== undefined) assertNonEmpty(request.search_after, "search_after")
}
