import type {
  PipedriveCursorOptions,
  PipedriveJsonObject,
  PipedriveJsonValue,
  QueryParams,
} from "./common"

export interface PipedrivePerson extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly first_name?: string
  readonly last_name?: string
  readonly owner_id?: number
  readonly org_id?: number | null
  readonly add_time?: string
  readonly update_time?: string
  readonly email?: PipedriveJsonValue
  readonly phone?: PipedriveJsonValue
  readonly custom_fields?: PipedriveJsonObject
}

export type PipedrivePersonListOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly filter_id?: number
    readonly ids?: readonly number[] | string
    readonly owner_id?: number
    readonly org_id?: number
    readonly updated_since?: string
    readonly updated_until?: string
    readonly sort_by?: "id" | "update_time" | "add_time"
    readonly sort_direction?: "asc" | "desc"
    readonly include_fields?: readonly string[] | string
    readonly custom_fields?: readonly string[] | string
  }

export type PipedrivePersonGetOptions = QueryParams & {
  readonly include_fields?: readonly string[] | string
  readonly custom_fields?: readonly string[] | string
}

export type PipedrivePersonSearchOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly term: string
    readonly fields?: readonly string[] | string
    readonly exact_match?: boolean
    readonly organization_id?: number
  }
