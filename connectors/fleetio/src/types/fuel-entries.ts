import type { FleetioComment } from "./comments"
import type {
  FleetioEqFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type {
  FleetioAttachmentAttributes,
  FleetioAttachmentPermissions,
  FleetioContactMini,
  FleetioDocument,
  FleetioImage,
  FleetioVehicleMeterEntry,
  FleetioVehicleMini,
  FleetioVendorMini,
} from "./shared"

export interface FleetioGeolocation {
  readonly gps_device?: string | null
  readonly original_vendor?: string | null
  readonly exception_distance_in_mi?: number | null
  readonly exception_distance_in_km?: number | null
}

export interface FleetioMapPreviews {
  readonly small?: string | null
  readonly large?: string | null
  readonly small_short?: string | null
  readonly large_short?: string | null
}

/** A Fuel Entry */
export interface FleetioFuelEntry {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The automatically calculated cost per hour since the last Fuel Entry. */
  readonly cost_per_hr: number | null
  /** The automatically calculated cost per km since the last Fuel Entry. */
  readonly cost_per_km: number | null
  /** The automatically calculated cost per mi since the last Fuel Entry. */
  readonly cost_per_mi: number | null
  /** The date and time at which this Fuel Entry was recorded. */
  readonly date: string
  /** Used to uniquely identify Fuel Entries that are imported from external systems, such as Fleetcor and Wex. */
  readonly external_id: string | null
  /** The Fleetio `id` of the `Fuel Type` associated with this Fuel Entry. */
  readonly fuel_type_id: number | null
  /** The name of the `Fuel Type` associated with this Fuel Entry. */
  readonly fuel_type_name: string | null
  /** Running average recorded kilometers per liter (calculated automatically). */
  readonly kpl: number | null
  /** The fuel volume amount in liters. */
  readonly liters: string | null
  /** Running average recorded liters per hour (calculated automatically). */
  readonly liters_per_hr: number | null
  /** Running average recorded liters per 100 kilometers (calculated automatically). */
  readonly lp100k: number | null
  /** Running average recorded miles per UK Gallon (calculated automatically). */
  readonly mpg_uk: number | null
  /** Running average recorded miles per US Gallon (calculated automatically). */
  readonly mpg_us: number | null
  /** Used to denote a partial fuel up as opposed to a complete fuel up. */
  readonly partial: boolean
  /** Used to denote a personal expense. */
  readonly personal: boolean
  /** The unit price for the `Vehicle`'s volume unit. */
  readonly price_per_volume_unit: number | null
  /** This object is dynamically populated by external fuel card integrations. */
  readonly raw_transaction_data: Readonly<Record<string, unknown>> | null
  /** Optional data field for collecting information such as the invoice number, transaction id, or receipt number, for example. */
  readonly reference: string | null
  readonly region: string | null
  readonly reset: boolean
  /** The fuel volume amount in UK gallons. */
  readonly uk_gallons: string
  /** Running average of UK gallons used per hour. */
  readonly uk_gallons_per_hr: number | null
  /** The fuel volume amount in US gallons. */
  readonly us_gallons: string
  /** Running average of US gallons used per hour. */
  readonly us_gallons_per_hr: number | null
  /** The automatically calculated usage in hours since the most recent Fuel Entry. */
  readonly usage_in_hr: string | null
  /** The automatically calculated usage in kilometers since the most recent Fuel Entry. */
  readonly usage_in_km: string | null
  /** The automatically calculated usage in miles since the most recent Fuel Entry. */
  readonly usage_in_mi: string | null
  /** The Fleetio `id` of the Vehicle associated with this Fuel Entry. */
  readonly vehicle_id: number | null
  /** The name of the Vehicle associated with this Fuel Entry. */
  readonly vehicle_name: string
  /** The Fleetio `id` of the Vendor associated with this Fuel Entry. */
  readonly vendor_id: number | null
  /** The name of the Vendor associated with this Fuel Entry. */
  readonly vendor_name: string | null
  readonly is_sample: boolean
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly fuel_economy_for_current_user?: string | null
  readonly fuel_economy_units_for_current_user?: string
  /** A Meter Entry */
  readonly meter_entry: FleetioVehicleMeterEntry | null
  readonly geolocation: FleetioGeolocation | null
  readonly map_previews: FleetioMapPreviews
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** The total amount of the Fuel Entry. */
  readonly total_amount: number
  /** A list of the comments made on this record. */
  readonly comments: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count: number
  /** A list of the images attached to this record. */
  readonly images?: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count: number
  /** A list of the documents attached to this record. */
  readonly documents?: readonly FleetioDocument[]
  /** The number of documents attached to this record. */
  readonly documents_count: number
  /** A Contact */
  readonly created_by?: FleetioContactMini | null
}

/** A Fuel Entry */
export interface FleetioFuelEntrySummary {
  readonly id?: number
  /** Used to uniquely identify Fuel Entries that are imported from external systems, such as Fleetcor and Wex. */
  readonly external_id?: string | null
  /** The Fleetio `id` of the `Fuel Type` associated with this Fuel Entry. */
  readonly fuel_type_id?: number | null
  /** The Fleetio `id` of the Vehicle associated with this Fuel Entry. */
  readonly vehicle_id?: number | null
  /** The Fleetio `id` of the Vendor associated with this Fuel Entry. */
  readonly vendor_id?: number | null
  /** Used to denote a partial fuel up as opposed to a complete fuel up. */
  readonly partial?: boolean
  /** Used to denote a personal expense. */
  readonly personal?: boolean
  /** Optional data field for collecting information such as the invoice number, transaction id, or receipt number, for example. */
  readonly reference?: string | null
  readonly region?: string | null
  readonly reset?: boolean
  /** The count of Images associated with this Fuel Entry. */
  readonly images_count?: number
  /** The count of Documents associated with this Fuel Entry. */
  readonly documents_count?: number
  /** The count of Comments associated with this Fuel Entry. */
  readonly comments_count?: number
  /** The count of Watchers associated with this Fuel Entry. */
  readonly watchers_count?: number
  readonly is_sample?: boolean
  /** The date and time at which this Fuel Entry was recorded. */
  readonly date?: string
  /** The date and time this Fuel Entry was created. */
  readonly created_at?: string
  /** The date and time this Fuel Entry was last updated. */
  readonly updated_at?: string
  /** The automatically calculated cost per hour since the last Fuel Entry. */
  readonly cost_per_hr?: string | null
  /** The automatically calculated cost per km since the last Fuel Entry. */
  readonly cost_per_km?: string | null
  /** The automatically calculated cost per mi since the last Fuel Entry. */
  readonly cost_per_mi?: string | null
  /** Running average recorded kilometers per liter (calculated automatically). */
  readonly kpl?: string | null
  /** The fuel volume amount in UK gallons. */
  readonly uk_gallons?: string
  /** Running average of UK gallons used per hour. */
  readonly uk_gallons_per_hr?: string | null
  /** The fuel volume amount in US gallons. */
  readonly us_gallons?: string
  /** Running average of US gallons used per hour. */
  readonly us_gallons_per_hr?: string | null
  /** The fuel volume amount in liters. */
  readonly liters?: string | null
  /** Running average recorded liters per hour (calculated automatically). */
  readonly liters_per_hr?: string | null
  /** Running average recorded liters per 100 kilometers (calculated automatically). */
  readonly lp100k?: string | null
  /** Running average recorded miles per UK Gallon (calculated automatically). */
  readonly mpg_uk?: string | null
  /** Running average recorded miles per US Gallon (calculated automatically). */
  readonly mpg_us?: string | null
  /** The unit price for the `Vehicle`'s volume unit. */
  readonly price_per_volume_unit?: string | null
  /** The automatically calculated usage in hours since the most recent Fuel Entry. */
  readonly usage_in_hr?: string | null
  /** The automatically calculated usage in kilometers since the most recent Fuel Entry. */
  readonly usage_in_km?: string | null
  /** The automatically calculated usage in miles since the most recent Fuel Entry. */
  readonly usage_in_mi?: string | null
  /** The total amount of the Fuel Entry in cents. */
  readonly total_amount_cents?: number
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A Vehicle */
  readonly vehicle?: FleetioVehicleMini
  /** A Meter Entry */
  readonly meter_entry?: FleetioVehicleMeterEntry | null
  /** A Vendor */
  readonly vendor?: FleetioVendorMini | null
}

export interface FleetioFuelEntryFilter {
  readonly external_id?: FleetioLikeOrEqFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly vendor_id?: FleetioEqFilter
  readonly date?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioFuelEntrySort {
  readonly id?: FleetioSortDirection
  readonly date?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioFuelEntryCreateInput {
  readonly vehicle_id: number
  /** The Fleetio `id` of the Vendor associated with this Fuel Entry. */
  readonly vendor_id?: number
  /** The Fleetio `id` of the Fuel Type associated with this Fuel Entry. */
  readonly fuel_type_id?: number
  /** We recommend using ISO-8601 formatted dates to avoid ambiguity. */
  readonly date: string
  /** The fuel volume amount in US gallons. */
  readonly us_gallons: number
  /** The fuel volume amount in UK gallons. */
  readonly uk_gallons?: number
  /** The fuel volume amount in liters. */
  readonly liters?: number
  /** The unit price for the Vehicle's configured volume unit. */
  readonly price_per_volume_unit?: number
  /** Each Fuel Entry requires an associated Meter Entry */
  readonly meter_entry_attributes: { readonly value?: number; readonly void?: boolean }
  /** A reference number or identifier for this Fuel Entry. */
  readonly reference?: string
  /** Indicates whether this Fuel Entry is a partial fill-up. */
  readonly partial?: boolean
  /** Indicates whether this Fuel Entry is personal. */
  readonly personal?: boolean
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
}

/** A Fuel Entry */
export interface FleetioFuelEntryWriteResult {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The automatically calculated cost per hour since the last Fuel Entry. */
  readonly cost_per_hr: number | null
  /** The automatically calculated cost per km since the last Fuel Entry. */
  readonly cost_per_km: number | null
  /** The automatically calculated cost per mi since the last Fuel Entry. */
  readonly cost_per_mi: number | null
  /** The date and time at which this Fuel Entry was recorded. */
  readonly date: string
  /** Used to uniquely identify Fuel Entries that are imported from external systems, such as Fleetcor and Wex. */
  readonly external_id: string | null
  /** The Fleetio `id` of the `Fuel Type` associated with this Fuel Entry. */
  readonly fuel_type_id: number | null
  /** The name of the `Fuel Type` associated with this Fuel Entry. */
  readonly fuel_type_name: string | null
  /** Running average recorded kilometers per liter (calculated automatically). */
  readonly kpl: number | null
  /** The fuel volume amount in liters. */
  readonly liters: string | null
  /** Running average recorded liters per hour (calculated automatically). */
  readonly liters_per_hr: number | null
  /** Running average recorded liters per 100 kilometers (calculated automatically). */
  readonly lp100k: number | null
  /** Running average recorded miles per UK Gallon (calculated automatically). */
  readonly mpg_uk: number | null
  /** Running average recorded miles per US Gallon (calculated automatically). */
  readonly mpg_us: number | null
  /** Used to denote a partial fuel up as opposed to a complete fuel up. */
  readonly partial: boolean
  /** Used to denote a personal expense. */
  readonly personal: boolean
  /** The unit price for the `Vehicle`'s volume unit. */
  readonly price_per_volume_unit: number | null
  /** This object is dynamically populated by external fuel card integrations. */
  readonly raw_transaction_data: Readonly<Record<string, unknown>> | null
  /** Optional data field for collecting information such as the invoice number, transaction id, or receipt number, for example. */
  readonly reference: string | null
  readonly region: string | null
  readonly reset: boolean
  /** The fuel volume amount in UK gallons. */
  readonly uk_gallons: string
  /** Running average of UK gallons used per hour. */
  readonly uk_gallons_per_hr: number | null
  /** The fuel volume amount in US gallons. */
  readonly us_gallons: string
  /** Running average of US gallons used per hour. */
  readonly us_gallons_per_hr: number | null
  /** The automatically calculated usage in hours since the most recent Fuel Entry. */
  readonly usage_in_hr: string | null
  /** The automatically calculated usage in kilometers since the most recent Fuel Entry. */
  readonly usage_in_km: string | null
  /** The automatically calculated usage in miles since the most recent Fuel Entry. */
  readonly usage_in_mi: string | null
  /** The Fleetio `id` of the Vehicle associated with this Fuel Entry. */
  readonly vehicle_id: number | null
  /** The name of the Vehicle associated with this Fuel Entry. */
  readonly vehicle_name: string
  /** The Fleetio `id` of the Vendor associated with this Fuel Entry. */
  readonly vendor_id: number | null
  /** The name of the Vendor associated with this Fuel Entry. */
  readonly vendor_name: string | null
  readonly is_sample: boolean
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly fuel_economy_for_current_user?: string | null
  readonly fuel_economy_units_for_current_user?: string
  /** A Meter Entry */
  readonly meter_entry: FleetioVehicleMeterEntry | null
  readonly geolocation: FleetioGeolocation | null
  readonly map_previews: FleetioMapPreviews
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** The total amount of the Fuel Entry. */
  readonly total_amount: number
  /** A list of the comments made on this record. */
  readonly comments: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count: number
  /** A list of the images attached to this record. */
  readonly images?: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count: number
  /** A list of the documents attached to this record. */
  readonly documents?: readonly FleetioDocument[]
  /** The number of documents attached to this record. */
  readonly documents_count: number
}

export type FleetioFuelEntryUpdateInput = Partial<FleetioFuelEntryCreateInput>

/** A Fuel Type */
export interface FleetioFuelType {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Fuel Type. */
  readonly name: string
  /** The number of `Vehicles` that have used this Fuel Type. */
  readonly vehicles_count: number
  /** The number of `Fuel Entries` that have used this Fuel Type. */
  readonly fuel_entries_count: number
}

export interface FleetioFuelTypeFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioFuelTypeSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioFuelTypeCreateInput {
  /** The name of the Fuel Type. */
  readonly name: string
}

export type FleetioFuelTypeUpdateInput = Partial<FleetioFuelTypeCreateInput>
