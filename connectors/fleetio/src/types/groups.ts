import type { FleetioLikeOrEqFilter, FleetioRangeFilter, FleetioSortDirection } from "./common"

/** A Group */
export interface FleetioGroup {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of the Group. */
  readonly name: string
  /** Indicates whether this Group is the default Group. */
  readonly default: boolean
  readonly parent_id: number | null
  /** A pipe delimited list of ancestor Group IDs, starting with the root Group and ending with the immediate parent Group. */
  readonly ancestry: string | null
}

export interface FleetioGroupFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioGroupSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioGroupCreateInput {
  readonly name: string
  /** Indicates whether this Group is the default Group. */
  readonly default?: boolean
  readonly parent_id?: number
  /** Create Group(s) from a pipe delimited hierarchy string. */
  readonly hierarchy?: string
}

/** A Group */
export interface FleetioGroupCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Group. */
  readonly name?: string
  /** Indicates whether this Group is the default Group. */
  readonly default?: boolean
  /** A pipe delimited list of ancestor Group IDs, starting with the root Group and ending with the immediate parent Group. */
  readonly ancestry?: string | null
  /** A pipe delimited list of ancestor Group names, starting with the root Group and ending with the immediate parent Group. */
  readonly ancestry_names: string | null
  /** The count of subscriptions to this Group. */
  readonly watched_group_subscriptions_count: number
  /** Indicates whether this Group is a sample Group. */
  readonly is_sample: boolean
  /** The count of unarchived `Vehicles` within this Group. */
  readonly unarchived_vehicles_count: number
}

export type FleetioGroupUpdateInput = Partial<FleetioGroupCreateInput>
