import type { PipedriveJsonObject, PipedriveOffsetOptions, QueryParams } from "./common"

export interface PipedriveFile extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly file_name?: string
  readonly file_type?: string
  readonly file_size?: number
  readonly deal_id?: number | null
  readonly lead_id?: string | null
  readonly person_id?: number | null
  readonly org_id?: number | null
  readonly product_id?: number | null
  readonly user_id?: number
  readonly add_time?: string
  readonly update_time?: string
}

export type PipedriveFileListOptions = QueryParams &
  PipedriveOffsetOptions & {
    readonly deal_id?: number
    readonly lead_id?: string
    readonly person_id?: number
    readonly org_id?: number
    readonly product_id?: number
    readonly user_id?: number
    readonly sort?: string
  }
