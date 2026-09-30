import type { FullEnrichSearchMetadata, FullEnrichSearchPage } from "./types"
import { MAX_SEARCH_LIMIT } from "./validation"

/**
 * Follow `search_after` cursors from the caller's first page. A short page, a missing cursor, or
 * a repeated cursor ends the iteration, so a stalled cursor cannot loop and keep charging credits.
 */
export async function* searchAllPages<TRequest extends FullEnrichSearchPage, TItem>(
  request: TRequest,
  search: (
    request: TRequest
  ) => Promise<{ readonly items: readonly TItem[]; readonly metadata?: FullEnrichSearchMetadata }>
): AsyncIterable<TItem> {
  const limit = request.limit ?? MAX_SEARCH_LIMIT
  let page: TRequest = { ...request, limit }
  const seen = new Set<string>()

  for (;;) {
    const { items, metadata } = await search(page)
    yield* items
    const cursor = metadata?.search_after
    if (items.length < limit || !cursor || seen.has(cursor)) return
    seen.add(cursor)
    const { offset: _offset, ...rest } = page
    page = { ...rest, search_after: cursor } as TRequest
  }
}
