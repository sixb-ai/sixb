import type { ConnectorAdapter } from "@sixb/core"
import type { createMondayClient } from "./client"

/** IDs stay strings, including IDs larger than JavaScript's safe integer range. */
export type MondayId = string
export type MondayJson =
  | null
  | boolean
  | number
  | string
  | readonly MondayJson[]
  | { readonly [key: string]: MondayJson }
export type MondayTokenResolver = string | (() => string | Promise<string>)
export interface MondayConnectorOptions {
  readonly token: MondayTokenResolver
  /** Full GraphQL endpoint; defaults to https://api.monday.com/v2. */
  readonly endpoint?: string
  /** Per-attempt timeout, including response consumption. Default: 30 seconds. */
  readonly timeoutMs?: number
  /** Minimum interval between requests per connection. Default: 100 ms. */
  readonly minDelayMs?: number
  /** Read retries only. Mutations are never replayed. Default: 2. */
  readonly maxRetries?: number
}
export interface MondayRequestOptions {
  readonly signal?: AbortSignal
}
export interface MondayWriteOptions extends MondayRequestOptions {
  /** Reuse only for the same intended operation; eligible responses are cached for 30 minutes. */
  readonly idempotencyKey?: string
}
export type MondayClient = ReturnType<typeof createMondayClient>
export type MondayConnector = ConnectorAdapter<"monday", MondayClient>

export interface MondayBoard {
  id: MondayId
  name: string
  description: string | null
  url: string
  board_kind: string
  type: string | null
  state: string
  access_level: "view" | "edit"
  hierarchy_type: string | null
  workspace_id: MondayId | null
  items_count: number | null
}
export interface MondayView {
  id: MondayId
  name: string
  type: string | null
}
export interface MondayColumn {
  id: string
  title: string
  type: string
  description: string | null
  /** Provider JSON, retained as returned (may be a JSON-encoded string). */
  settings: MondayJson
  revision: string
}
export interface MondayGroup {
  id: string
  title: string
  color: string
}
export interface MondayColumnValue {
  id: string
  type: string
  text: string | null
  /** Raw provider JSON; do not use display text as a write representation. */
  value: MondayJson
}
export interface MondayItem {
  id: MondayId
  name: string
  url: string
  created_at: string | null
  updated_at: string | null
  /** Physical board; classic subitems can belong to a separate board. */
  board: { id: MondayId } | null
  parent_item: { id: MondayId } | null
  group: { id: string; title: string } | null
  column_values: MondayColumnValue[]
}
export interface MondayItemReference {
  id: MondayId
  board: { id: MondayId } | null
}
export interface MondayItemPage {
  cursor: string | null
  items: MondayItem[]
}
export interface MondayUpdate {
  id: MondayId
  body: string
  text_body: string | null
  created_at: string | null
  updated_at: string | null
  creator_id: string | null
  replies: MondayReply[] | null
}
export interface MondayReply {
  id: MondayId
  body: string
  text_body: string | null
  created_at: string | null
  updated_at: string | null
  creator_id: string | null
}
export interface MondayUser {
  id: MondayId
  name: string
  kind: string
  status: string
}
export interface MondayAsset {
  id: MondayId
  name: string
  file_extension: string
  file_size: number
  url: string
  /** Temporary URL, not durable storage. */
  public_url: string
  created_at: string | null
}

export interface MondayPageOptions {
  limit?: number
  page?: number
}
export interface MondayBoardListOptions extends MondayPageOptions {
  workspace_ids?: readonly MondayId[]
  state?: "active" | "archived" | "deleted" | "all"
}
export type MondayFilterOperator =
  | "any_of"
  | "not_any_of"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "greater_than_or_equals"
  | "lower_than"
  | "lower_than_or_equal"
  | "between"
  | "starts_with"
  | "ends_with"
  | "contains_text"
  | "contains_terms"
  | "not_contains_text"
  | "within_the_last"
  | "within_the_next"
export interface MondayItemsQuery {
  rules?: readonly {
    column_id: string
    compare_value: string | number | boolean | readonly (string | number)[]
    compare_attribute?: string
    operator?: MondayFilterOperator
  }[]
  operator?: "and" | "or"
  order_by?: readonly { column_id: string; direction: "asc" | "desc" }[]
}
export interface MondayItemListOptions {
  board_id: MondayId
  limit?: number
  /** Start a new filtered traversal; continuation uses items.nextPage. */
  query_params?: MondayItemsQuery
  /** Undefined reads all column values; [] reads none. */
  column_ids?: readonly string[]
}
export interface MondayItemReadOptions {
  column_ids?: readonly string[]
}

/** Provider write shapes for the supported, writable column types. */
export type MondayColumnWriteValue =
  | null
  | string
  | { text: string }
  | { label: string }
  | { index: number }
  | { date: string; time?: string }
  | { url: string; text: string }
  | { personsAndTeams: readonly { id: number; kind: "person" | "team" }[] }
  | { from: string; to: string }
  | Record<string, never>
export type MondayColumnWrites = Readonly<Record<string, MondayColumnWriteValue>>
export interface MondayCreateItemParameters {
  board_id: MondayId
  group_id?: string
  item_name: string
  column_values?: MondayColumnWrites
}
export interface MondayCreateSubitemParameters {
  parent_item_id: MondayId
  item_name: string
  column_values?: MondayColumnWrites
}
export interface MondayChangeColumnsParameters {
  board_id: MondayId
  item_id: MondayId
  column_values: MondayColumnWrites
}
