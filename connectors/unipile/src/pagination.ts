import type { UnipileCursorOptions, UnipileCursorPage } from "./types"

type ListMethod<TOptions, TPage> = (options?: TOptions) => Promise<TPage>

/** Follows Unipile's opaque cursor while preserving the caller's filters. */
export async function* listAllCursor<
  TOptions extends UnipileCursorOptions,
  TPage extends UnipileCursorPage<TItem>,
  TItem,
>(list: ListMethod<TOptions, TPage>, options?: TOptions): AsyncIterable<TItem> {
  let pageOptions = options
  const seenCursors = new Set<string>()

  for (;;) {
    const page = await list(pageOptions)
    for (const item of page.items) {
      yield item
    }

    const cursor = page.cursor
    if (!cursor) {
      return
    }
    if (seenCursors.has(cursor)) {
      throw new Error("[SixbUnipile] Pagination returned a repeated cursor.")
    }

    seenCursors.add(cursor)
    pageOptions = { ...pageOptions, cursor } as TOptions
  }
}
