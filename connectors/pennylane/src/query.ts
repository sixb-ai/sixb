import type { PennylaneCursorOptions, QueryParams } from "./types"

type ListQueryOptions = PennylaneCursorOptions & {
  readonly filter?: readonly unknown[]
  readonly sort?: string
}

/**
 * Serializes list query parameters into Pennylane's wire format: the opaque `cursor`, the page
 * `limit`, `filter` as a JSON array string (omitted when empty), and the `sort` direction. Shared
 * by every list resource so filter serialization lives in exactly one place.
 */
export function buildListQuery(options?: ListQueryOptions): QueryParams {
  return {
    cursor: options?.cursor,
    limit: options?.limit,
    filter: options?.filter?.length ? JSON.stringify(options.filter) : undefined,
    sort: options?.sort,
  }
}
