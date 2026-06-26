import type { PipedriveCursorOptions, PipedriveJsonObject, QueryParams } from "./common"

export type PipedriveDealStatus = "open" | "won" | "lost" | "deleted"

export interface PipedriveDeal extends PipedriveJsonObject {
  readonly id: number
  readonly title?: string
  readonly owner_id?: number
  readonly person_id?: number | null
  readonly org_id?: number | null
  readonly pipeline_id?: number
  readonly stage_id?: number
  readonly value?: number
  readonly currency?: string
  readonly status?: PipedriveDealStatus | string
  readonly add_time?: string
  readonly update_time?: string
  readonly expected_close_date?: string | null
  readonly close_time?: string | null
  readonly won_time?: string | null
  readonly lost_time?: string | null
  readonly is_deleted?: boolean
  readonly is_archived?: boolean
  readonly custom_fields?: PipedriveJsonObject
}

export type PipedriveDealListOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly filter_id?: number
    readonly ids?: readonly number[] | string
    readonly owner_id?: number
    readonly person_id?: number
    readonly org_id?: number
    readonly pipeline_id?: number
    readonly stage_id?: number
    readonly status?: PipedriveDealStatus | string
    readonly updated_since?: string
    readonly updated_until?: string
    readonly sort_by?: "id" | "update_time" | "add_time"
    readonly sort_direction?: "asc" | "desc"
    readonly include_fields?: readonly string[] | string
    readonly custom_fields?: readonly string[] | string
    readonly include_option_labels?: boolean
    readonly include_labels?: boolean
  }

export type PipedriveDealGetOptions = QueryParams & {
  readonly include_fields?: readonly string[] | string
  readonly custom_fields?: readonly string[] | string
  readonly include_option_labels?: boolean
  readonly include_labels?: boolean
}

export type PipedriveDealSearchOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly term: string
    readonly fields?: readonly string[] | string
    readonly exact_match?: boolean
    readonly person_id?: number
    readonly organization_id?: number
    readonly status?: PipedriveDealStatus | string
    readonly include_fields?: readonly string[] | string
  }

export interface PipedriveDealSearchItem extends PipedriveJsonObject {
  readonly id?: number
  readonly title?: string
  readonly type?: "deal" | string
}
