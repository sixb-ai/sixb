import type { PipedriveCursorOptions, PipedriveJsonObject, QueryParams } from "./common"

export interface PipedriveOrganization extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly owner_id?: number
  readonly add_time?: string
  readonly update_time?: string
  readonly address?: string
  readonly custom_fields?: PipedriveJsonObject
}

export type PipedriveOrganizationListOptions = QueryParams &
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

export type PipedriveOrganizationGetOptions = QueryParams & {
  readonly include_fields?: readonly string[] | string
  readonly custom_fields?: readonly string[] | string
}

export type PipedriveOrganizationSearchOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly term: string
    readonly fields?: readonly string[] | string
    readonly exact_match?: boolean
  }
