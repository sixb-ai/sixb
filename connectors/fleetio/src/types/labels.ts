import type { FleetioLikeOrEqFilter, FleetioSortDirection } from "./common"

/** A Label */
export interface FleetioLabel {
  readonly id: number
  readonly account_id: number
  /** The name of the Label. */
  readonly name: string
  /** The number of records that have been tagged with this Label. */
  readonly taggings_count: number
  /** The hex color of the Label. */
  readonly color: string
}

export interface FleetioLabelFilter {
  readonly name?: FleetioLikeOrEqFilter
}

export interface FleetioLabelSort {
  readonly id?: FleetioSortDirection
}

export interface FleetioLabelCreateInput {
  /** The name of the Label. */
  readonly name: string
}
