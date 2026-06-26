import type { PipedriveJsonObject, PipedriveOffsetOptions, QueryParams } from "./common"

export interface PipedriveUser extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly email?: string
  readonly active_flag?: boolean
  readonly is_admin?: boolean
  readonly created?: string
  readonly modified?: string
}

export type PipedriveUserListOptions = QueryParams &
  PipedriveOffsetOptions & {
    readonly ids?: readonly number[] | string
  }

export type PipedriveUserFindOptions = QueryParams & {
  readonly term: string
  readonly search_by_email?: boolean | 0 | 1
}
