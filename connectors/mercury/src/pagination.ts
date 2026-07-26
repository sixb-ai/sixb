import type { MercuryCursorOptions, MercuryCursorPage } from "./types"

type ListMethod<TOptions, TPage> = (options?: TOptions) => Promise<TPage>

/**
 * Iterates a cursor-paginated Mercury collection.
 *
 * Mercury's cursors are resource ids: each page reports the id to resume after as
 * `page.nextPage`, and omits it on the last page. Because the item key differs per resource
 * (`accounts`, `transactions`, `customers`, `data`, …), callers pass an `items` selector.
 *
 * The first request uses the caller's options verbatim, so `start_at`, `end_before`, and every
 * filter apply. Subsequent requests replace those cursors with `start_after`, since following
 * `nextPage` is forward-only.
 */
export async function* listAllCursor<
  TOptions extends MercuryCursorOptions,
  TPage extends MercuryCursorPage,
  TItem,
>(
  list: ListMethod<TOptions, TPage>,
  items: (page: TPage) => readonly TItem[],
  options?: TOptions
): AsyncIterable<TItem> {
  let pageOptions = options
  const seenCursors = new Set<string>()

  for (;;) {
    const page = await list(pageOptions)
    for (const item of items(page)) {
      yield item
    }

    const nextCursor = page.page?.nextPage
    if (!nextCursor) {
      return
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("[SixbMercury] Pagination returned a repeated nextPage cursor.")
    }

    seenCursors.add(nextCursor)
    pageOptions = nextCursorOptions(pageOptions, nextCursor)
  }
}

interface OffsetOptions {
  readonly limit?: number
  readonly offset?: number
}

/**
 * Iterates an offset-paginated Mercury collection. Only `GET /account/{id}/transactions` uses
 * this style; it reports `total` instead of a cursor, so paging stops once the offset reaches it.
 */
export async function* listAllOffset<TOptions extends OffsetOptions, TPage, TItem>(
  list: ListMethod<TOptions, TPage>,
  items: (page: TPage) => readonly TItem[],
  total: (page: TPage) => number,
  options?: TOptions
): AsyncIterable<TItem> {
  let offset = options?.offset ?? 0

  for (;;) {
    const page = await list({ ...options, offset } as TOptions)
    const batch = items(page)
    for (const item of batch) {
      yield item
    }

    if (batch.length === 0) {
      return
    }

    offset += batch.length
    if (offset >= total(page)) {
      return
    }
  }
}

function nextCursorOptions<TOptions extends MercuryCursorOptions>(
  options: TOptions | undefined,
  cursor: string
): TOptions {
  const {
    end_before: _endBefore,
    start_at: _startAt,
    ...rest
  } = (options ?? {}) as TOptions & { readonly start_at?: string }

  return { ...rest, start_after: cursor } as unknown as TOptions
}
