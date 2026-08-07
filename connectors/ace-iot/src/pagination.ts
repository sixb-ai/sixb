import type { AceIotListAllOptions, AceIotPage, AceIotTimeseriesPage } from "./types"

/** Page size `listAll*` uses when the caller does not pick one. ACE's own default is 10. */
export const DEFAULT_LIST_ALL_PER_PAGE = 1000

type PageListMethod<TOptions, TItem> = (options: TOptions) => Promise<AceIotPage<TItem>>

/**
 * Walk ACE's `page`/`per_page` envelope.
 *
 * `pages` is not a reliable stop condition on its own — the gateway PCAP listing returns
 * `"pages": null` — so the walk also stops on an empty page, on a short page, and on reaching
 * `total`.
 */
export async function* listAllPages<TOptions extends AceIotListAllOptions, TItem>(
  list: PageListMethod<TOptions, TItem>,
  options?: TOptions
): AsyncIterable<TItem> {
  const perPage = options?.perPage ?? DEFAULT_LIST_ALL_PER_PAGE
  const maxPages = options?.maxPages
  let page = options?.page ?? 1
  let fetchedPages = 0
  let fetchedItems = 0

  for (;;) {
    const result = await list({ ...options, page, perPage } as TOptions)

    for (const item of result.items) {
      yield item
    }

    fetchedPages += 1
    fetchedItems += result.items.length

    if (result.items.length === 0) return
    if (maxPages !== undefined && fetchedPages >= maxPages) return
    if (typeof result.pages === "number" && page >= result.pages) return
    if (typeof result.total === "number" && fetchedItems >= result.total) return
    if (result.items.length < (result.per_page ?? perPage)) return

    page += 1
  }
}

/**
 * The decoded form of a timeseries `next_cursor`: how many rows of the bucket at `timestamp` have
 * already been returned.
 */
export interface AceIotTimeseriesCursor {
  readonly offset: number
  readonly timestamp: string
}

export function encodeTimeseriesCursor(cursor: AceIotTimeseriesCursor): string {
  return btoa(JSON.stringify({ offset: cursor.offset, timestamp: cursor.timestamp }))
}

export function decodeTimeseriesCursor(cursor: string): AceIotTimeseriesCursor | null {
  try {
    const decoded: unknown = JSON.parse(atob(cursor))
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as AceIotTimeseriesCursor).offset !== "number" ||
      typeof (decoded as AceIotTimeseriesCursor).timestamp !== "string"
    ) {
      return null
    }

    const { offset, timestamp } = decoded as AceIotTimeseriesCursor
    return Number.isInteger(offset) && offset >= 0 ? { offset, timestamp } : null
  } catch {
    return null
  }
}

/**
 * Compute the cursor that actually reaches the next page.
 *
 * ACE sets `next_cursor.offset` to the number of rows it returned from the final timestamp bucket
 * of the page, without adding the offset the request carried in. When a page begins and ends inside
 * one bucket the cursor it hands back is therefore the cursor it was given, and a
 * `while (has_more)` loop re-requests the same page forever. Measured against a live site, a
 * 3,222-sample window walked with the server's own cursor yields 100 rows at `page_size=50` and
 * then stalls.
 *
 * The correct offset is recoverable from the page itself, because the server does honor an offset
 * it is given: carry the incoming offset when the page ended in the bucket it started in, and add
 * the rows this page took from that final bucket. Where ACE's cursor is already right — any page
 * that crosses into a later bucket — this returns the identical value.
 */
export function repairTimeseriesCursor(
  incoming: string | null | undefined,
  page: AceIotTimeseriesPage
): string | null {
  const samples = page.point_samples
  if (!page.has_more || samples.length === 0) {
    return null
  }

  const lastTimestamp = samples[samples.length - 1].time
  let rowsFromLastBucket = 0
  for (
    let index = samples.length - 1;
    index >= 0 && samples[index].time === lastTimestamp;
    index--
  ) {
    rowsFromLastBucket += 1
  }

  const previous = incoming ? decodeTimeseriesCursor(incoming) : null
  const carried = previous?.timestamp === lastTimestamp ? previous.offset : 0

  return encodeTimeseriesCursor({ offset: carried + rowsFromLastBucket, timestamp: lastTimestamp })
}

type TimeseriesPageMethod<TOptions> = (options: TOptions) => Promise<AceIotTimeseriesPage>

/**
 * Identify a page by its size and its end rows. `(name, time)` is a reading's natural key, so two
 * consecutive pages sharing a fingerprint hold the same rows.
 */
function pageFingerprint(page: AceIotTimeseriesPage): string {
  const samples = page.point_samples
  const first = samples[0]
  const last = samples[samples.length - 1]
  return `${samples.length}|${first.name}@${first.time}|${last.name}@${last.time}`
}

/**
 * Walk `GET /sites/{site_name}/timeseries/paginated` to the end of the window, repairing ACE's
 * cursor on every hop.
 *
 * A page identical to the one before it means the walk is not advancing, and is raised rather than
 * looped on. Comparing pages rather than cursors is what makes this a real bound: the repaired
 * cursor always advances by construction, so a cursor that never repeats proves nothing about
 * whether the server is actually moving through the window.
 */
export async function* iterateTimeseriesPages<
  TOptions extends { readonly cursor?: string; readonly maxPages?: number },
>(getPage: TimeseriesPageMethod<TOptions>, options: TOptions): AsyncIterable<AceIotTimeseriesPage> {
  const maxPages = options.maxPages
  let cursor = options.cursor
  let fetchedPages = 0
  let previousFingerprint: string | null = null

  for (;;) {
    const page = await getPage({ ...options, cursor } as TOptions)

    if (page.point_samples.length > 0) {
      const fingerprint = pageFingerprint(page)
      if (fingerprint === previousFingerprint) {
        throw new Error(
          "[SixbAceIot] Timeseries pagination returned the same page twice and would not advance."
        )
      }
      previousFingerprint = fingerprint
    }

    yield page

    fetchedPages += 1
    if (maxPages !== undefined && fetchedPages >= maxPages) return

    const nextCursor = repairTimeseriesCursor(cursor, page)
    if (!nextCursor) return

    cursor = nextCursor
  }
}
