import type { MercuryCursorOptions, QueryParams } from "./types"

/**
 * Serializes the cursor pagination parameters shared by every Mercury list endpoint. Resource
 * modules spread their own filters on top of the result.
 */
export function cursorQuery(options?: MercuryCursorOptions): QueryParams {
  return {
    limit: options?.limit,
    order: options?.order,
    start_after: options?.start_after,
    end_before: options?.end_before,
  }
}
