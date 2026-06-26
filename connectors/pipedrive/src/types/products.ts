import type { PipedriveCursorOptions, PipedriveJsonObject, QueryParams } from "./common"

export interface PipedriveProduct extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly code?: string
  readonly description?: string
  readonly owner_id?: number
  readonly active_flag?: boolean
  readonly add_time?: string
  readonly update_time?: string
  readonly custom_fields?: PipedriveJsonObject
}

export type PipedriveProductListOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly filter_id?: number
    readonly ids?: readonly number[] | string
    readonly owner_id?: number
    readonly updated_since?: string
    readonly updated_until?: string
    readonly sort_by?: "id" | "update_time" | "add_time"
    readonly sort_direction?: "asc" | "desc"
    readonly include_fields?: readonly string[] | string
    readonly custom_fields?: readonly string[] | string
  }

export type PipedriveProductGetOptions = QueryParams & {
  readonly include_fields?: readonly string[] | string
  readonly custom_fields?: readonly string[] | string
}

export type PipedriveProductSearchOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly term: string
    readonly fields?: readonly string[] | string
    readonly exact_match?: boolean
  }
