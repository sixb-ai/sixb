import type { PipedriveJsonObject, QueryParams } from "./common"

export interface PipedriveFieldOption extends PipedriveJsonObject {
  readonly id?: number | string
  readonly label?: string
}

export interface PipedriveField extends PipedriveJsonObject {
  readonly id?: number
  readonly key?: string
  readonly field_code?: string
  readonly name?: string
  readonly field_type?: string
  readonly edit_flag?: boolean
  readonly active_flag?: boolean
  readonly is_custom_field?: boolean
  readonly options?: readonly PipedriveFieldOption[] | null
}

export type PipedriveDealField = PipedriveField
export type PipedrivePersonField = PipedriveField
export type PipedriveOrganizationField = PipedriveField
export type PipedriveProductField = PipedriveField
export type PipedriveActivityField = PipedriveField

export type PipedriveFieldListOptions = QueryParams & {
  readonly limit?: number
  readonly cursor?: string
}
