import type { CtmCall, CtmCallPage, CtmPage } from "./types"
import { isRecord } from "./validation"

/**
 * Records per request when walking a whole list. CTM defaults to 10, which would spend ten times
 * the requests of its 10-a-second budget.
 */
export const WALK_PAGE_SIZE = 100

/** Arrays a list envelope carries besides its records. */
const ENVELOPE_ARRAYS = new Set(["sort"])

/**
 * Reads a page-numbered list into a `CtmPage`.
 *
 * CTM names the records array after the resource, and a few routes use another name (the
 * do-not-call list answers with `receiving_numbers`), so when `key` is absent the envelope's only
 * other array is taken. `next_page` cannot say where the list ends, because some routes return a
 * URL on the last page too, so `total_pages` decides when it is there.
 */
export function toPage<TRecord>(
  body: unknown,
  key: string,
  requestedPage: number
): CtmPage<TRecord> {
  const records = readRecords<TRecord>(body, key)
  const envelope = isRecord(body) ? body : {}

  const page = readNumber(envelope.page) ?? requestedPage
  const totalPages = readNumber(envelope.total_pages)
  const hasMore =
    totalPages === null ? records.length > 0 && Boolean(envelope.next_page) : page < totalPages

  return {
    records,
    page,
    perPage: readNumber(envelope.per_page),
    totalEntries: readNumber(envelope.total_entries) ?? readNumber(envelope.total),
    totalPages,
    nextPage: hasMore ? page + 1 : null,
  }
}

/** Reads one page of the call log, which pages with an `after` cursor. */
export function toCallPage(body: unknown): CtmCallPage {
  const records = readRecords<CtmCall>(body, "calls")
  const envelope = isRecord(body) ? body : {}
  const after = typeof envelope.after === "string" && envelope.after ? envelope.after : null

  return {
    records,
    after: records.length > 0 ? after : null,
    perPage: readNumber(envelope.per_page),
    totalEntries: readNumber(envelope.total_entries),
    totalPages: readNumber(envelope.total_pages),
    stats: isRecord(envelope.stats) ? envelope.stats : {},
  }
}

/** Walks a page-numbered list from `startPage` until a page says it is the last. */
export async function* walkPages<TRecord>(
  read: (page: number) => Promise<CtmPage<TRecord>>,
  startPage = 1
): AsyncIterable<TRecord> {
  let page: number | null = startPage

  while (page !== null) {
    const current: CtmPage<TRecord> = await read(page)
    yield* current.records

    if (current.nextPage !== null && current.nextPage <= page) {
      throw new Error("[SixbCtm] Pagination did not advance.")
    }

    page = current.nextPage
  }
}

/** Walks the call log, following `after` until a page has none. */
export async function* walkCalls(
  read: (after: string | undefined) => Promise<CtmCallPage>,
  startAfter?: string
): AsyncIterable<CtmCall> {
  let after = startAfter
  const seen = new Set<string>()

  for (;;) {
    const page = await read(after)
    yield* page.records

    if (!page.after) {
      return
    }

    if (seen.has(page.after)) {
      throw new Error("[SixbCtm] Pagination returned a repeated after cursor.")
    }

    seen.add(page.after)
    after = page.after
  }
}

function readRecords<TRecord>(body: unknown, key: string): TRecord[] {
  if (Array.isArray(body)) {
    return body as TRecord[]
  }

  if (!isRecord(body)) {
    throw new Error(`[SixbCtm] Expected a list of ${key}, got ${describe(body)}.`)
  }

  const named = body[key]
  if (Array.isArray(named)) {
    return named as TRecord[]
  }

  const arrays = Object.entries(body).filter(
    ([field, value]) => Array.isArray(value) && !ENVELOPE_ARRAYS.has(field)
  )
  if (arrays.length === 1) {
    return arrays[0]?.[1] as TRecord[]
  }

  throw new Error(
    `[SixbCtm] Expected a list of ${key}, got fields ${Object.keys(body).join(", ")}.`
  )
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }

  return null
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value
}
