/**
 * A record ID. CTM uses integers for some records (calls, accounts, custom fields) and prefixed
 * strings for others (`CA…` call SIDs, `USR…` users, `TPN…` tracking numbers, `RPN…` receiving
 * numbers). Both are accepted as path segments.
 */
export type CtmId = string | number

/** Page-numbered list options, shared by every list except calls. */
export interface CtmPageOptions {
  /** The page to read, starting at 1. */
  readonly page?: number
  /** Records per page. CTM defaults to 10. */
  readonly pageSize?: number
}

/**
 * One page of a page-numbered list. CTM names the records array after the resource (`users`,
 * `queues`, …); the connector reads it into `records`.
 */
export interface CtmPage<TRecord> {
  readonly records: readonly TRecord[]
  readonly page: number
  readonly perPage: number | null
  readonly totalEntries: number | null
  readonly totalPages: number | null
  /** The page after this one, or `null` on the last page. */
  readonly nextPage: number | null
}

/**
 * A record CTM publishes no response example for. The fields arrive as CTM returns them; only the
 * ID is guaranteed.
 */
export interface CtmRecord {
  readonly id: CtmId
  readonly name?: string | null
  readonly [field: string]: unknown
}

/** A JSON object CTM publishes no example of, such as most write answers. It arrives as returned. */
export type CtmObject = Readonly<Record<string, unknown>>
