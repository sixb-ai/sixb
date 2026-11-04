import type { PipedriveJsonObject, PipedriveResponse, QueryParams } from "./common"

export interface PipedriveFieldOption extends PipedriveJsonObject {
  /** An integer for options you can edit. Some built-in options use a string or a boolean. */
  readonly id?: number | string | boolean
  readonly label?: string
  readonly color?: string | null
  readonly add_time?: string | null
  readonly update_time?: string | null
}

export interface PipedriveFieldSubfield extends PipedriveJsonObject {
  readonly field_code?: string
  readonly field_name?: string
  readonly field_type?: string
}

export interface PipedriveField extends PipedriveJsonObject {
  readonly field_name: string
  readonly field_code: string
  readonly field_type: string
  readonly options?: readonly PipedriveFieldOption[] | null
  readonly subfields?: readonly PipedriveFieldSubfield[] | null
  readonly is_custom_field: boolean
  readonly is_optional_response_field: boolean
  readonly is_writable?: boolean
  readonly description?: string | null
  /** Returned when requested through `include_fields`. */
  readonly ui_visibility?: PipedriveJsonObject
  /** Returned when requested through `include_fields`. */
  readonly important_fields?: PipedriveJsonObject
  /** Returned when requested through `include_fields`. */
  readonly required_fields?: PipedriveJsonObject
}

export type PipedriveDealField = PipedriveField
export type PipedrivePersonField = PipedriveField
export type PipedriveOrganizationField = PipedriveField
export type PipedriveProductField = PipedriveField
export type PipedriveActivityField = PipedriveField

export type PipedriveFieldIncludeField = "ui_visibility" | "important_fields" | "required_fields"

export type PipedriveFieldGetOptions = QueryParams & {
  /** Product and activity fields support `ui_visibility` only. */
  readonly include_fields?: readonly PipedriveFieldIncludeField[]
}

export type PipedriveFieldListOptions = PipedriveFieldGetOptions & {
  readonly limit?: number
  readonly cursor?: string
}

export type PipedriveFieldType =
  | "varchar"
  | "text"
  | "double"
  | "phone"
  | "date"
  | "daterange"
  | "time"
  | "timerange"
  | "set"
  | "enum"
  | "varchar_auto"
  | "address"
  | "monetary"
  | "org"
  | "people"
  | "user"

export interface PipedriveFieldVisibilityInput {
  readonly add_visible_flag?: boolean
  readonly details_visible_flag?: boolean
}

export interface PipedriveFieldDialogVisibilityInput {
  readonly show?: boolean
  readonly order?: number | null
}

export interface PipedrivePersonFieldVisibilityInput extends PipedriveFieldVisibilityInput {
  readonly show_in_add_deal_dialog?: PipedriveFieldDialogVisibilityInput
}

export interface PipedriveOrganizationFieldVisibilityInput
  extends PipedrivePersonFieldVisibilityInput {
  readonly show_in_add_person_dialog?: PipedriveFieldDialogVisibilityInput
}

export interface PipedriveDealFieldVisibilityInput extends PipedriveFieldVisibilityInput {
  readonly projects_detail_visible_flag?: boolean
  readonly show_in_pipelines?: {
    readonly show_in_all?: boolean
    readonly pipeline_ids?: readonly number[]
  }
}

export interface PipedriveImportantFieldsInput {
  readonly enabled?: boolean
  readonly stage_ids?: readonly number[]
}

export interface PipedriveRequiredFieldsInput {
  readonly enabled?: boolean
}

export interface PipedriveDealRequiredFieldsInput extends PipedriveRequiredFieldsInput {
  readonly stage_ids?: readonly number[]
  readonly statuses?: Readonly<Record<string, readonly ("won" | "lost")[]>>
}

export interface PipedriveProductFieldUpdateInput {
  readonly field_name?: string
  readonly ui_visibility?: PipedriveFieldVisibilityInput
}

export interface PipedrivePersonFieldUpdateInput {
  readonly field_name?: string
  readonly ui_visibility?: PipedrivePersonFieldVisibilityInput
  readonly important_fields?: PipedriveImportantFieldsInput
  readonly required_fields?: PipedriveRequiredFieldsInput
}

export interface PipedriveOrganizationFieldUpdateInput extends PipedrivePersonFieldUpdateInput {
  readonly ui_visibility?: PipedriveOrganizationFieldVisibilityInput
}

export interface PipedriveDealFieldUpdateInput {
  readonly field_name?: string
  readonly description?: string
  readonly ui_visibility?: PipedriveDealFieldVisibilityInput
  readonly important_fields?: PipedriveImportantFieldsInput
  readonly required_fields?: PipedriveDealRequiredFieldsInput
}

export type PipedriveFieldCreateInput<TUpdate> = TUpdate & {
  readonly field_name: string
  readonly field_type: PipedriveFieldType
  /** Required when `field_type` is `enum` or `set`. */
  readonly options?: readonly PipedriveFieldOptionAddInput[]
}

export interface PipedriveFieldOptionAddInput {
  readonly label: string
}

export interface PipedriveFieldOptionUpdateInput {
  readonly id: number
  readonly label: string
}

export interface PipedriveFieldOptionDeleteInput {
  readonly id: number
}

export interface PipedriveFieldOptionResult extends PipedriveJsonObject {
  readonly id: number
  readonly label: string
}

/** Holds only the options the call added, updated or deleted, not the field's full list. */
export type PipedriveFieldOptionsResponse = PipedriveResponse<
  readonly PipedriveFieldOptionResult[],
  null
>
