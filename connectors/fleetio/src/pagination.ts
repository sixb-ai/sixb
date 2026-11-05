import type { FleetioPage } from "./types"

/**
 * Walks every page of a Fleetio list, following `next_cursor` until it is `null`. The caller's
 * filter and sort apply to every page, because a cursor does not carry them.
 */
export async function* listAllPages<TOptions extends { readonly cursor?: string }, TRecord>(
  list: (options?: TOptions) => Promise<FleetioPage<TRecord>>,
  options?: TOptions
): AsyncIterable<TRecord> {
  let cursor = options?.cursor
  const seenCursors = new Set<string>()

  for (;;) {
    const page = await list({ ...options, cursor } as TOptions)
    for (const record of page.records) {
      yield record
    }

    if (!page.next_cursor) {
      return
    }
    if (seenCursors.has(page.next_cursor)) {
      throw new Error("[SixbFleetio] Pagination returned a repeated next_cursor.")
    }

    seenCursors.add(page.next_cursor)
    cursor = page.next_cursor
  }
}
