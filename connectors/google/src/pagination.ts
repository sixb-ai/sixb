/**
 * Every Google list endpoint paginates the same way: pass `pageToken`, read
 * `nextPageToken` from the response, stop when it's absent. One helper covers
 * every surface (contrast pipedrive, which needed cursor + offset variants).
 */
export async function* listAllPages<TPage extends { nextPageToken?: string }, TItem>(
  list: (pageToken?: string) => Promise<TPage>,
  select: (page: TPage) => readonly TItem[] | undefined,
  initialPageToken?: string
): AsyncIterable<TItem> {
  let pageToken = initialPageToken
  // A response that hands back a token already followed would otherwise loop forever.
  const seen = new Set<string>(initialPageToken ? [initialPageToken] : [])

  for (;;) {
    const page = await list(pageToken)
    for (const item of select(page) ?? []) {
      yield item
    }

    pageToken = page.nextPageToken
    if (!pageToken) {
      break
    }
    if (seen.has(pageToken)) {
      throw new Error(
        `[SixbGoogle] Pagination repeated page token "${pageToken}"; refusing to loop forever.`
      )
    }
    seen.add(pageToken)
  }
}
