import type {
  LinkedinCursorOptions,
  LinkedinCursorPage,
  LinkedinOffsetOptions,
  LinkedinOffsetPage,
} from "./types/common"

type CursorListMethod<TOptions extends LinkedinCursorOptions, TItem> = (
  options: TOptions
) => Promise<LinkedinCursorPage<TItem>>

export async function* listAllCursor<TOptions extends LinkedinCursorOptions, TItem>(
  list: CursorListMethod<TOptions, TItem>,
  options?: TOptions
): AsyncIterable<TItem> {
  let pageToken = options?.pageToken
  const seenTokens = new Set<string>()
  if (pageToken) seenTokens.add(pageToken)

  for (;;) {
    const page = await list({ ...options, pageToken } as TOptions)
    for (const item of page.items) yield item

    if (!page.nextPageToken) return
    if (seenTokens.has(page.nextPageToken)) {
      throw new Error("[SixbLinkedin] Pagination returned a repeated nextPageToken.")
    }
    seenTokens.add(page.nextPageToken)
    pageToken = page.nextPageToken
  }
}

type OffsetListMethod<TOptions extends LinkedinOffsetOptions, TItem> = (
  options: TOptions
) => Promise<LinkedinOffsetPage<TItem>>

export async function* listAllOffset<TOptions extends LinkedinOffsetOptions, TItem>(
  list: OffsetListMethod<TOptions, TItem>,
  options?: TOptions
): AsyncIterable<TItem> {
  let start = options?.start ?? 0
  const requestedCount = options?.count ?? 100

  for (;;) {
    const page = await list({ ...options, start, count: requestedCount } as TOptions)
    for (const item of page.items) yield item

    const nextLink = page.paging.links?.find((link) => link.rel?.toLowerCase() === "next")
    if (page.items.length === 0 && !nextLink) return

    const nextStart =
      startFromLink(nextLink?.href) ??
      page.paging.start + Math.max(page.paging.count, page.items.length)
    if (page.paging.total !== undefined && nextStart >= page.paging.total && !nextLink) return
    if (page.paging.total === undefined && page.items.length < requestedCount && !nextLink) {
      return
    }
    if (nextStart <= start) {
      throw new Error("[SixbLinkedin] Pagination did not advance the start offset.")
    }
    start = nextStart
  }
}

function startFromLink(href: string | undefined): number | undefined {
  if (!href) return undefined
  try {
    const value = new URL(href, "https://api.linkedin.com").searchParams.get("start")
    if (value === null) return undefined
    const start = Number(value)
    return Number.isInteger(start) && start >= 0 ? start : undefined
  } catch {
    return undefined
  }
}
