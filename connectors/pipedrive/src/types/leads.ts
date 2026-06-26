import type { PipedriveJsonObject, PipedriveOffsetOptions, QueryParams } from "./common"

export interface PipedriveLead extends PipedriveJsonObject {
  readonly id: string
  readonly title?: string
  readonly owner_id?: number
  readonly person_id?: number | null
  readonly organization_id?: number | null
  readonly value?: PipedriveJsonObject
  readonly expected_close_date?: string | null
  readonly add_time?: string
  readonly update_time?: string
  readonly custom_fields?: PipedriveJsonObject
}

export type PipedriveLeadListOptions = QueryParams &
  PipedriveOffsetOptions & {
    readonly archived_status?: "archived" | "not_archived" | "all"
    readonly owner_id?: number
    readonly person_id?: number
    readonly organization_id?: number
    readonly filter_id?: number
    readonly sort?: string
  }

export type PipedriveLeadSearchOptions = QueryParams &
  PipedriveOffsetOptions & {
    readonly term: string
    readonly fields?: readonly string[] | string
    readonly exact_match?: boolean
  }
