import type { TiktokCursorPage, TiktokNumberedPage } from "./types/common"

export async function* paginateCursor<T>(
  fetchPage: (cursor: number | undefined) => Promise<TiktokCursorPage<T>>,
  initialCursor?: number
): AsyncIterable<T> {
  let cursor = initialCursor
  const seen = new Set<number>()

  for (;;) {
    const page = await fetchPage(cursor)
    for (const item of page.items) yield item
    if (!page.hasMore) return
    if (page.nextCursor === undefined || page.nextCursor === cursor || seen.has(page.nextCursor)) {
      throw new Error("[SixbTikTok] TikTok returned a repeated or missing pagination cursor.")
    }
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

export async function* paginateNumbered<T>(
  fetchPage: (page: number) => Promise<TiktokNumberedPage<T>>,
  initialPage = 1
): AsyncIterable<T> {
  let pageNumber = initialPage
  const seen = new Set<number>()

  for (;;) {
    if (seen.has(pageNumber)) {
      throw new Error("[SixbTikTok] TikTok returned a repeated page number.")
    }
    seen.add(pageNumber)

    const page = await fetchPage(pageNumber)
    for (const item of page.items) yield item

    const {
      page: current,
      page_size: pageSize,
      total_number: total,
      total_page: totalPages,
    } = page.pageInfo
    const lastPage = totalPages ?? Math.ceil(total / Math.max(pageSize, 1))
    if (page.items.length === 0 || current >= lastPage) return
    pageNumber = current + 1
  }
}
