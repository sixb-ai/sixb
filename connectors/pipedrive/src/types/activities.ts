import type { PipedriveCursorOptions, PipedriveJsonObject, QueryParams } from "./common"

export interface PipedriveActivity extends PipedriveJsonObject {
  readonly id: number
  readonly subject?: string
  readonly type?: string
  readonly owner_id?: number
  readonly deal_id?: number | null
  readonly lead_id?: string | null
  readonly person_id?: number | null
  readonly org_id?: number | null
  readonly due_date?: string | null
  readonly due_time?: string | null
  readonly duration?: string | null
  readonly done?: boolean
  readonly add_time?: string
  readonly update_time?: string
}

export type PipedriveActivityListOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly filter_id?: number
    readonly ids?: readonly number[] | string
    readonly owner_id?: number
    readonly deal_id?: number
    readonly lead_id?: string
    readonly person_id?: number
    readonly org_id?: number
    readonly done?: boolean
    readonly updated_since?: string
    readonly updated_until?: string
    readonly sort_by?: "id" | "update_time" | "add_time" | "due_date"
    readonly sort_direction?: "asc" | "desc"
  }
