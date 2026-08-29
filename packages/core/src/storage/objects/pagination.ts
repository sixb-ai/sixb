const DEFAULT_OBJECT_LIST_LIMIT = 50

export interface NormalizedObjectListWindow {
  readonly limit: number
  readonly offset: number
}

/** Shared provider-contract validation for object list windows. */
export function normalizeObjectListWindow(input: {
  readonly limit?: number
  readonly offset?: number
}): NormalizedObjectListWindow {
  return {
    limit: nonNegativeSafeInteger(input.limit ?? DEFAULT_OBJECT_LIST_LIMIT, "limit"),
    offset: nonNegativeSafeInteger(input.offset ?? 0, "offset"),
  }
}

/** Compute has-more without overflowing `offset + returnedRows`. */
export function objectListHasMore(input: {
  readonly total: number
  readonly offset: number
  readonly returnedRows: number
}): boolean {
  return input.offset < input.total && input.returnedRows < input.total - input.offset
}

/** Saturating `limit + 1` for provider operations that do not already know the total. */
export function objectListLookaheadLimit(limit: number): number {
  return limit === Number.MAX_SAFE_INTEGER ? limit : limit + 1
}

function nonNegativeSafeInteger(value: number, field: "limit" | "offset"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`[Sixb] Object list ${field} must be a non-negative safe integer.`)
  }
  return value
}
