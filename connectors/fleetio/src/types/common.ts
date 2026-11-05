/** A record ID. Fleetio serializes IDs as integers and accepts them as path segments either way. */
export type FleetioId = string | number

export type FleetioFilterValue = string | number | boolean

export interface FleetioEqFilter {
  readonly eq: FleetioFilterValue
}

export interface FleetioLikeFilter {
  readonly like: string
}

export type FleetioLikeOrEqFilter = FleetioLikeFilter | FleetioEqFilter

/** Fleetio documents one operator per field; datetimes are ISO 8601 strings. */
export type FleetioRangeFilter =
  | { readonly lt: string }
  | { readonly lte: string }
  | { readonly gt: string }
  | { readonly gte: string }

export type FleetioEqOrRangeFilter = FleetioEqFilter | FleetioRangeFilter

export interface FleetioBooleanFilter {
  readonly eq: boolean | "true" | "false"
}

/** Matches any of the values. An array is sent as Fleetio's comma-separated list. */
export interface FleetioIncludeFilter {
  readonly include: string | readonly (string | number)[]
}

export type FleetioIncludeOrEqFilter = FleetioIncludeFilter | FleetioEqFilter

export type FleetioSortDirection = "asc" | "desc"

/** Options every paginated list takes. Filter and sort fields are specific to each endpoint. */
export interface FleetioListOptions<TFilter = never, TSort = never> {
  /** Resume from a page's `next_cursor`. Leave unset for the first page. */
  readonly cursor?: string
  /** Records per page, 1 to 100. Fleetio's default is 50. */
  readonly pageSize?: number
  readonly filter?: TFilter
  readonly sort?: TSort
}

/** The envelope every paginated Fleetio list returns. */
export interface FleetioPage<TRecord> {
  readonly start_cursor: string | null
  /** Cursor for the next page, or `null` on the last page. */
  readonly next_cursor: string | null
  readonly per_page: number
  /** Remaining records including this page, capped at 500. This is not a total. */
  readonly estimated_remaining_count: number
  /** The filters Fleetio applied, echoed back. */
  readonly filtered_by?: readonly Readonly<Record<string, unknown>>[]
  /** The sort Fleetio applied, echoed back. */
  readonly sorted_by?: readonly Readonly<Record<string, unknown>>[]
  readonly records: readonly TRecord[]
}
