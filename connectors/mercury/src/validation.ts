import type { MercuryCursorOptions } from "./types"

/** Mercury caps every list endpoint at 1000 results per page. */
export const MAX_LIMIT = 1000

export function pathId(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbMercury] ${field} must be a non-empty string.`)
  }

  return encodeURIComponent(value)
}

export function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`[SixbMercury] limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
}

/**
 * Validates the cursor options every list endpoint shares. Mercury rejects `start_after` and
 * `end_before` together because they paginate in opposite directions.
 */
export function assertCursorOptions(options: MercuryCursorOptions | undefined): void {
  if (options?.limit !== undefined) {
    assertLimit(options.limit)
  }

  assertCursor(options?.start_after, "start_after")
  assertCursor(options?.end_before, "end_before")

  if (options?.start_after !== undefined && options.end_before !== undefined) {
    throw new Error("[SixbMercury] start_after and end_before are mutually exclusive.")
  }
}

/** `GET /transactions` adds `start_at`, which excludes both directional cursors. */
export function assertTransactionCursorOptions(
  options: (MercuryCursorOptions & { readonly start_at?: string }) | undefined
): void {
  assertCursorOptions(options)
  assertCursor(options?.start_at, "start_at")

  if (
    options?.start_at !== undefined &&
    (options.start_after !== undefined || options.end_before !== undefined)
  ) {
    throw new Error("[SixbMercury] start_at cannot be combined with start_after or end_before.")
  }
}

export function assertOffset(offset: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("[SixbMercury] offset must be a non-negative integer.")
  }
}

function assertCursor(value: string | undefined, field: string): void {
  if (value !== undefined && !value.trim()) {
    throw new Error(`[SixbMercury] ${field} must not be empty when provided.`)
  }
}
