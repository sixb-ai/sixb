import type { PipedriveCursorOptions, PipedriveJsonObject, QueryParams } from "./common"

export interface PipedriveOrganizationAddress extends PipedriveJsonObject {
  readonly value?: string
  readonly country?: string
  readonly admin_area_level_1?: string
  readonly admin_area_level_2?: string
  readonly locality?: string
  readonly sublocality?: string
  readonly route?: string
  readonly street_number?: string
  readonly subpremise?: string
  readonly postal_code?: string
}

export interface PipedriveOrganization extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly owner_id?: number
  readonly add_time?: string
  readonly update_time?: string
  readonly visible_to?: number
  readonly label_ids?: readonly number[]
  readonly address?: string | PipedriveOrganizationAddress
  readonly custom_fields?: PipedriveJsonObject
}

export interface PipedriveOrganizationInput extends PipedriveJsonObject {
  readonly name: string
  readonly owner_id?: number
  readonly add_time?: string
  readonly update_time?: string
  readonly visible_to?: number
  readonly label_ids?: readonly number[]
  readonly address?: PipedriveOrganizationAddress
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
