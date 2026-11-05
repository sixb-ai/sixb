import type { FleetioEqFilter, FleetioRangeFilter, FleetioSortDirection } from "./common"

/** The formula configuration for a Custom Field whose value is calculated rather than entered by a user. */
export interface FleetioCalculatedCustomFieldConfig {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The ID of the `Account` that this configuration belongs to. */
  readonly account_id: number
  /** The ID of the `Custom Field` whose value this configuration calculates. */
  readonly custom_field_id: number
  /** How the calculated value is formatted. */
  readonly format: "number" | "percentage"
  /** The expression evaluated to produce the Custom Field's value. */
  readonly formula: string
  /** The keys of the Custom Fields referenced by `formula`. */
  readonly variables: readonly string[]
}

export interface FleetioCustomField {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The ID of the `Account` that this Custom Field belongs to. */
  readonly account_id?: number
  /** Used when `data_type` is `association` and `custom_field_type` is `custom_object_template` determines to which kind of record the Custom Field belongs to. */
  readonly association_type?: string | null
  /** When `custom_field_type` is `custom_object_template` it determines to which key of the Custom Records it belongs to. */
  readonly custom_object_key?: string | null
  /** Whether this Custom Field is the primary association for its Custom Object. */
  readonly primary_association: boolean
  /** The property category that this Custom Field belongs to. */
  readonly property_category?: string | null
  readonly custom_field_type: string
  readonly data_type: "checkbox" | "currency" | "date" | "dropdown" | "number" | "text"
  readonly description: string
  readonly key: string
  readonly label: string
  readonly required: boolean
  readonly values: readonly string[] | null
  readonly position: number | null
  /** Whether the user viewing this Custom Field can update it. */
  readonly can_update: boolean
  /** Whether the value of this Custom Field is calculated from a formula instead of being entered by a user. */
  readonly is_calculated: boolean
  /** The formula configuration for a Custom Field whose value is calculated rather than entered by a user. */
  readonly calculated_custom_field_config?: FleetioCalculatedCustomFieldConfig
}

export interface FleetioCustomFieldFilter {
  readonly custom_field_type?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioCustomFieldSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}
