import type {
  FleetioEqFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"

export interface FleetioWatcherFilter {
  readonly email?: FleetioLikeOrEqFilter
  readonly name?: FleetioLikeOrEqFilter
  readonly group_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioWatcherSort {
  readonly group_id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}
