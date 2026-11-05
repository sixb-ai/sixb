import type {
  FleetioEqFilter,
  FleetioEqOrRangeFilter,
  FleetioIncludeFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"

/** A Meter Entry */
export interface FleetioMeterEntry {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The date and time at which this Meter Entry was automatically voided. */
  readonly auto_voided_at: string | null
  /** A category to describe the function of this Meter Entry. */
  readonly category: "starting" | "ending" | "nightly" | "manual" | null
  /** Indicates whether this Meter Entry is for a secondary meter. */
  readonly meter_type: "secondary" | null
  readonly meterable_id: number | null
  /** The type of the object with which this Meter Entry is associated. */
  readonly meterable_type:
    | "FuelEntry"
    | "Issue"
    | "PurchaseDetail"
    | "ServiceEntry"
    | "SubmittedInspectionItem"
    | "VehicleAssignment"
    | "WorkOrder"
    | null
  /** The current value of the meter. */
  readonly value: string
  readonly vehicle_id: number | null
  /** Indicates whether or not this Meter Entry has been voided. */
  readonly void: boolean
  /** Indicates if this Meter Entry was submitted by a GPS provider. */
  readonly type: "GpsMeterEntry" | null
  /** The GPS provider that submitted this Meter Entry. */
  readonly gps_provider: string | null
  /** The date on which this Meter Entry was recorded. */
  readonly date: string
}

/** A Meter Entry */
export interface FleetioMeterEntrySummary {
  readonly id: number
  /** The date and time at which this Meter Entry was automatically voided. */
  readonly auto_voided_at: string | null
  /** A category to describe the function of this Meter Entry. */
  readonly category: "starting" | "ending" | "nightly" | "manual" | null
  /** Indicates whether this meter is a primary or secondary meter. */
  readonly meter_type: "primary" | "secondary"
  /** The id of the object with which this Meter Entry is associated. */
  readonly meterable_id: number | null
  /** The type of the object with which this Meter Entry is associated. */
  readonly meterable_type:
    | "FuelEntry"
    | "Issue"
    | "PurchaseDetail"
    | "ServiceEntry"
    | "SubmittedInspectionItem"
    | "VehicleAssignment"
    | "WorkOrder"
    | null
  /** The current value of the meter. */
  readonly value: string
  /** The id of the `Vehicle` associated with this meter entry, if any. */
  readonly vehicle_id: number | null
  /** Indicates whether or not this Meter Entry has been voided. */
  readonly void: boolean
  /** Indicates if this Meter Entry was submitted by a GPS provider. */
  readonly type: "GpsMeterEntry" | null
  /** The GPS provider that submitted this Meter Entry. */
  readonly gps_provider: string | null
  /** The date on which this Meter Entry was recorded. */
  readonly date: string
  readonly created_at?: string
  readonly updated_at?: string
}

export interface FleetioMeterEntryFilter {
  readonly category?: FleetioIncludeFilter
  readonly meterable_type?: FleetioIncludeFilter
  readonly meterable_id?: FleetioEqFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly date?: FleetioEqOrRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioMeterEntrySort {
  readonly id?: FleetioSortDirection
  readonly date?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioMeterEntryCreateInput {
  readonly vehicle_id: number
  /** The value of the meter. */
  readonly value: number
  /** Meter Entries must follow the correct sequence, incrementing in value by date. */
  readonly date: string
  /** Whether to mark this Meter Entry void or not. */
  readonly void?: boolean
  /** If this is a secondary meter reading, use this field. */
  readonly meter_type?: "secondary" | null
}

/** A MeterEntry */
export interface FleetioMeterEntryCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The date and time at which this Meter Entry was automatically voided. */
  readonly auto_voided_at: string | null
  /** A category to describe the function of this Meter Entry. */
  readonly category: "starting" | "ending" | "nightly" | "manual" | null
  /** Indicates whether this Meter Entry is for a secondary meter. */
  readonly meter_type: "secondary" | null
  readonly meterable_id: number | null
  /** The type of the object with which this Meter Entry is associated. */
  readonly meterable_type:
    | "FuelEntry"
    | "Issue"
    | "PurchaseDetail"
    | "ServiceEntry"
    | "SubmittedInspectionItem"
    | "VehicleAssignment"
    | "WorkOrder"
    | null
  /** The current value of the meter. */
  readonly value: string
  readonly vehicle_id: number | null
  /** Indicates whether or not this Meter Entry has been voided. */
  readonly void: boolean
  /** The GPS provider that submitted this Meter Entry. */
  readonly gps_provider: string | null
  /** The date on which this Meter Entry was recorded. */
  readonly date: string
  /** The date and time at which the `Vehicle` associated with this Meter Entry was archived, if applicable. */
  readonly vehicle_archived_at?: string | null
  /** The reason this Meter Entry was automatically voided. */
  readonly auto_void_reason?: string | null
  /** Indicates whether or not this Meter Entry is sample data. */
  readonly is_sample?: boolean
  readonly gps_device_id?: number | null
  /** The source of this Meter Entry. */
  readonly source?: string | null
  /** The number of active meter conflicts caused by this Meter Entry. */
  readonly active_meter_conflicts_caused_count?: number
}

export type FleetioMeterEntryUpdateInput = Partial<FleetioMeterEntryCreateInput>
