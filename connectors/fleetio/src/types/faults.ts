import type {
  FleetioEqFilter,
  FleetioIncludeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioVehicleMini } from "./shared"

/** A Fault */
export interface FleetioFault {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  readonly vehicle_id?: number | null
  /** The diagnostic trouble code. */
  readonly code?: string
  /** The number of times this Fault has occurred. */
  readonly count?: number | null
  /** A short description about the problem. */
  readonly description?: string | null
  /** An external identifier for the Fault, if applicable. */
  readonly external_id?: string | null
  /** The date and time when the Fault last occurred. */
  readonly last_occurred_at?: string | null
  /** The name or label for the Fault. */
  readonly name?: string | null
  /** The status of the Fault. */
  readonly status?: "open" | "resolved" | "ignored"
  /** The source or origin of the Fault. */
  readonly source?: string | null
  /** The date and time when the associated `Vehicle` was archived, if applicable. */
  readonly vehicle_archived_at?: string | null
  readonly fault_rule_id?: number | null
  /** Indicates if the Fault is sample data. */
  readonly is_sample?: boolean
  /** An optional key for idempotent operations. */
  readonly idempotency_key?: string | null
}

/** A Fault */
export interface FleetioFaultSummary {
  readonly id?: number
  readonly account_id: number
  readonly vehicle_id: number | null
  /** The diagnostic trouble code. */
  readonly code: string
  /** The number of times this Fault has occurred. */
  readonly count: number | null
  /** A short description about the problem. */
  readonly description: string | null
  /** An external identifier for the Fault, if applicable. */
  readonly external_id?: string | null
  /** The date and time when the Fault last occurred. */
  readonly last_occurred_at: string | null
  /** The name or label for the Fault. */
  readonly name: string | null
  /** The status of the Fault. */
  readonly status: "open" | "resolved" | "ignored"
  /** The source or origin of the Fault. */
  readonly source?: string | null
  /** The date and time when the associated `Vehicle` was archived, if applicable. */
  readonly vehicle_archived_at: string | null
  readonly fault_rule_id?: number | null
  /** Indicates if the Fault is sample data. */
  readonly is_sample?: boolean
  /** An optional key for idempotent operations. */
  readonly idempotency_key?: string | null
  /** A Vehicle */
  readonly vehicle?: FleetioVehicleMini
  readonly created_at?: string
  readonly updated_at?: string
}

export interface FleetioFaultFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly external_id?: FleetioEqFilter
  readonly fault_rule_id?: FleetioEqFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly status_id?: FleetioIncludeFilter
  readonly code?: FleetioEqFilter
  readonly last_occurred_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioFaultSort {
  readonly id?: FleetioSortDirection
  readonly last_occurred_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioFaultCreateInput {
  readonly vehicle_id: number
  /** The diagnostic trouble code. */
  readonly code: string
  /** The number of times this Fault has occurred. */
  readonly count?: number
  /** A short description about the problem. */
  readonly description?: string
  /** An external identifier for the Fault, if applicable. */
  readonly external_id?: string
  /** The date and time when the Fault last occurred. */
  readonly last_occurred_at?: string
  /** The name or label for the Fault. */
  readonly name?: string
  /** The status of the Fault. */
  readonly status?: "open" | "resolved" | "ignored"
  /** The source or origin of the Fault. */
  readonly source?: string
}

export type FleetioFaultUpdateInput = Partial<FleetioFaultCreateInput>
