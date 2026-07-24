import type { PennylaneCursorOptions, PennylaneCursorPage } from "./types"

type CursorListMethod<
  TOptions extends PennylaneCursorOptions,
  TItem,
  THasMore extends boolean | null,
> = (options?: TOptions) => Promise<PennylaneCursorPage<TItem, THasMore>>

export async function* listAllCursor<
  TOptions extends PennylaneCursorOptions,
  TItem,
  THasMore extends boolean | null,
>(list: CursorListMethod<TOptions, TItem, THasMore>, options?: TOptions): AsyncIterable<TItem> {
  let cursor = options?.cursor
  const seenCursors = new Set<string>()
  if (cursor) {
    seenCursors.add(cursor)
  }

  for (;;) {
    const page = await list({ ...options, cursor } as TOptions)
    for (const item of page.items) {
      yield item
    }

    if (page.has_more !== true) {
      return
    }

    const nextCursor = page.next_cursor
    if (!nextCursor) {
      throw new Error(
        "[SixbPennylane] Pagination response has_more=true but next_cursor is missing."
      )
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("[SixbPennylane] Pagination returned a repeated next_cursor.")
    }

    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}
