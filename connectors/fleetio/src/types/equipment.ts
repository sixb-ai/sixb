import type {
  FleetioEqFilter,
  FleetioEqOrRangeFilter,
  FleetioIncludeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type {
  FleetioAttachmentAttributes,
  FleetioAttachmentPermissions,
  FleetioContactMini,
  FleetioCurrentLocationEntry,
  FleetioEmbeddedContact,
  FleetioMeasurementSystem,
  FleetioMeterUnit,
  FleetioVehicleDriver,
  FleetioVehicleMini,
  FleetioVehicleSpecs,
  FleetioVendorMini,
  FleetioVolumeUnit,
} from "./shared"

export type FleetioVehicleOwnershipResponse =
  | "Owned"
  | "Leased"
  | "Rented"
  | "Customer"
  | "Financed"
  | "Rent To Own"

/** A Vehicle */
export interface FleetioEmbeddedVehicle {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  /** The date and time at which the Vehicle was archived. */
  readonly archived_at?: string | null
  readonly fuel_type_id?: number | null
  /** The name of the `Fuel Type` associated with this Vehicle. */
  readonly fuel_type_name?: string | null
  readonly fuel_volume_units?: FleetioVolumeUnit
  readonly group_id?: number | null
  /** The name of the `Group` associated with this Vehicle. */
  readonly group_name?: string | null
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly meter_unit?: FleetioMeterUnit | null
  /** This Vehicle's name. */
  readonly name?: string
  readonly ownership?: FleetioVehicleOwnershipResponse
  /** Indicates whether or not this Vehicle has a secondary meter. */
  readonly secondary_meter?: boolean
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly secondary_meter_unit?: FleetioMeterUnit | null
  readonly system_of_measurement?: FleetioMeasurementSystem
  /** The `Labels` associated with this Vehicle. */
  readonly labels?: readonly {
    readonly id?: number
    readonly name?: string
    readonly color?: string
  }[]
  readonly vehicle_status_id?: number
  /** The name of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_name?: string
  /** The color of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_color?: string | null
  readonly vehicle_type_id?: number
  /** The name of the `Vehicle Type` associated with this Vehicle. */
  readonly vehicle_type_name?: string
  /** The number of `Fuel Entries` associated with this Vehicle. */
  readonly fuel_entries_count?: number
  /** The number of `Service Entries` associated with this Vehicle. */
  readonly service_entries_count?: number
  /** The number of `Service Reminders` associated with this Vehicle. */
  readonly service_reminders_count?: number
  /** The number of `Vehicle Renewal Reminders` associated with this Vehicle. */
  readonly vehicle_renewal_reminders_count?: number
  /** The number of `Comments` associated with this Vehicle. */
  readonly comments_count?: number
  /** The number of documents attached to this Vehicle. */
  readonly documents_count?: number
  /** The number of images attached to this Vehicle. */
  readonly images_count?: number
  readonly current_location_entry_id?: number | null
  /** Indicates whether this Vehicle record is Sample Data. */
  readonly is_sample?: boolean
  /** The date on which this Vehicle was put into service. */
  readonly in_service_date?: string | null
  /** The meter value at which this Vehicle was put into service. */
  readonly in_service_meter?: number | null
  /** The estimated number of months this Vehicle will be in service. */
  readonly estimated_service_months?: number | null
  /** The estimated number of miles before which this Vehicle will be replaced. */
  readonly estimated_replacement_mileage?: number | null
  /** The estimated resale price of this Vehicle. */
  readonly estimated_resale_price?: {
    readonly cents?: number
    readonly currency_iso?: string
  } | null
  /** The date on which this Vehicle was or will be retired. */
  readonly out_of_service_date?: string | null
  /** The meter value at which this Vehicle was or will be retired. */
  readonly out_of_service_meter?: number | null
  /** The name of the primary meter for this Vehicle. */
  readonly meter_name?: string
  /** The name of the secondary meter for this Vehicle. */
  readonly secondary_meter_name?: string
  /** The average number of units of the primary meter used per day. */
  readonly primary_meter_usage_per_day?: string | null
  /** The average number of units of the secondary meter used per day. */
  readonly secondary_meter_usage_per_day?: string | null
  /** The current value of the primary meter for this Vehicle. */
  readonly current_meter_value?: number | null
  /** The date and time at which the primary meter was last updated. */
  readonly current_meter_date?: string | null
  /** The current value of the secondary meter for this Vehicle. */
  readonly secondary_meter_value?: number | null
  /** The date and time at which the secondary meter was last updated. */
  readonly secondary_meter_date?: string | null
  /** The ancestry of the Group associated with this Vehicle. */
  readonly group_ancestry?: string | null
  /** The color of this Vehicle. */
  readonly color?: string | null
  /** The license plate number of this Vehicle. */
  readonly license_plate?: string | null
  /** The Vehicle Identification Number of this Vehicle. */
  readonly vin?: string | null
  /** This Vehicle's model year. */
  readonly year?: number | null
  /** The name of this Vehicle's manufacturer. */
  readonly make?: string | null
  /** The name of the model of this Vehicle. */
  readonly model?: string | null
  /** The trim level of this Vehicle. */
  readonly trim?: string | null
  /** The month in which this Vehicle's registration expires. */
  readonly registration_expiration_month?: number | null
  /** The state, province, or territory in which this Vehicle is registered. */
  readonly registration_state?: string | null
  /** The account number for this Vehicle's loan, if applicable. */
  readonly loan_account_number?: string | null
  /** The date and time at which this Vehicle's loan ends. */
  readonly loan_ended_at?: string | null
  /** The interest rate for this Vehicle's loan. */
  readonly loan_interest_rate?: number | null
  /** Notes about this Vehicle's loan. */
  readonly loan_notes?: string | null
  /** The date and time at which this Vehicle's loan began. */
  readonly loan_started_at?: string | null
  readonly loan_vendor_id?: number | null
  /** The name of the `Vendor` for this Vehicle's loan. */
  readonly loan_vendor_name?: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The number of inspection schedules this Vehicle is associated with. */
  readonly inspection_schedules_count?: number
  /** The number of `Issues` this Vehicle is associated with. */
  readonly issues_count?: number
  /** The number of `Work Orders` this Vehicle is associated with. */
  readonly work_orders_count?: number
  /** The name of the `Vehicle Type` associated with this Vehicle. */
  readonly type_name?: string | null
  /** The URL of the default image for this Vehicle. */
  readonly default_image_url?: string | null
  /** The URL of a medium-sized version of the default image for this Vehicle. */
  readonly default_image_url_medium?: string | null
  /** The URL of a small-sized version of the default image for this Vehicle. */
  readonly default_image_url_small?: string | null
  /** The URL of a large-sized version of the default image for this Vehicle. */
  readonly default_image_url_large?: string | null
  readonly specs?: FleetioVehicleSpecs
  /** Any External IDs associated with this Vehicle. */
  readonly external_ids?: Readonly<Record<string, unknown>>
  /** Whether this Vehicle has Auto Integrate enabled for it. */
  readonly ai_enabled?: boolean
  /** Assetable type for Vehicle is always `Vehicle` for vehicles. */
  readonly assetable_type?: "Vehicle"
  readonly driver?: FleetioVehicleDriver
  /** The current location of the associated object. */
  readonly current_location_entry?: FleetioCurrentLocationEntry | null
  /** The amount of this Vehicle's loan. */
  readonly loan_amount?: number | null
  /** The amount of this Vehicle's loan payment. */
  readonly loan_payment?: number | null
  /** The number of active warranties associated with this Vehicle. */
  readonly warranties_active_count?: number
  /** The number of warranties associated with this Vehicle. */
  readonly warranties_count?: number
  /** The residual value of this Vehicle at the end of its lease. */
  readonly residual_value?: number | null
  /** The id of the `Axle Configuration` of this vehicle. */
  readonly axle_config_id?: number | null
}

export interface FleetioEquipment {
  readonly id: number
  readonly created_at: string
  readonly updated_at: string
  /** The name for this Equipment. */
  readonly name: string
  /** The name of the brand which makes this Equipment. */
  readonly brand: string | null
  /** The model name of this Equipment. */
  readonly model: string | null
  /** The serial number of this Equipment. */
  readonly serial_number: string | null
  readonly equipment_type_id: number
  /** The name of the associated `Equipment Type`. */
  readonly type_name: string
  readonly equipment_status_id: number
  /** The name of the associated `Equipment Status`. */
  readonly status_name: string
  readonly group_id: number | null
  /** The name of the associated `Group`. */
  readonly group_name: string | null
  readonly purchase_vendor_id: number | null
  /** The purchase price in cents. */
  readonly purchase_price_cents: number | null
  /** The date on which the Equipment was purchased. */
  readonly purchase_date: string | null
  /** The estimated resale price of this Equipment. */
  readonly estimated_resale_price: number | null
  /** The date on which the Equipment warranty expires. */
  readonly warranty_expiration_date: string | null
  /** Any comments about the purchase of this Equipment. */
  readonly purchase_comments: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The date on which the Equipment was put into service. */
  readonly in_service_date: string | null
  /** The estimated duration in months of the service life for this Equipment. */
  readonly estimated_service_life: number | null
  /** The estimated date on which the Equipment will be retired from service. */
  readonly out_of_service_date: string | null
  /** The date and time at which the Equipment was archived. */
  readonly archived_at: string | null
  /** The color of the associated `Equipment Status`. */
  readonly status_color: string | null
  /** A Vehicle */
  readonly linked_vehicle: FleetioEmbeddedVehicle | null
  /** A Contact */
  readonly assigned_contact: FleetioEmbeddedContact | null
  readonly attachment_permissions: FleetioAttachmentPermissions | null
  /** The URL of the Equipment's default image/profile photo, if any. */
  readonly default_image_url: string | null
  /** The type of assetable object. */
  readonly assetable_type: string | null
  /** The number of `Issues` associated with this Equipment. */
  readonly issues_count: number
  /** The current location of the associated object. */
  readonly current_location_entry: FleetioCurrentLocationEntry | null
  /** The number of `Comments` associated with this Equipment. */
  readonly comments_count: number
  /** The number of documents associated with this Equipment. */
  readonly documents_count: number
  /** The number of images associated with this Equipment. */
  readonly images_count: number
  /** Indicates whether this Equipment is being watched. */
  readonly is_watched: boolean
  /** The number of users watching this Equipment. */
  readonly watchers_count: number
}

export interface FleetioEquipmentSummary {
  readonly created_at: string
  readonly updated_at: string
  readonly id: number
  /** The name for this Equipment. */
  readonly name: string
  /** The name of the brand which makes this Equipment. */
  readonly brand: string | null
  /** The model name of this Equipment. */
  readonly model: string | null
  /** The serial number of this Equipment. */
  readonly serial_number: string | null
  readonly equipment_type_id: number
  /** The name of the associated `Equipment Type`. */
  readonly type_name: string
  readonly equipment_status_id: number
  /** The name of the associated `Equipment Status`. */
  readonly status_name: string
  readonly group_id: number | null
  readonly purchase_vendor_id: number | null
  /** The purchase price in cents. */
  readonly purchase_price_cents: number | null
  /** The date on which the Equipment was purchased. */
  readonly purchase_date: string | null
  /** The estimated resale price in cents of this Equipment. */
  readonly estimated_resale_price_cents: number | null
  /** The date on which the Equipment warranty expires. */
  readonly warranty_expiration_date: string | null
  /** Any comments about the purchase of this Equipment. */
  readonly purchase_comments: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The date on which the Equipment was put into service. */
  readonly in_service_date: string | null
  /** The estimated duration in months of the service life for this Equipment. */
  readonly estimated_service_life: number | null
  /** The estimated date on which the Equipment will be retired from service. */
  readonly out_of_service_date: string | null
  /** The date and time at which the Equipment was archived. */
  readonly archived_at: string | null
  /** The color of the associated `Equipment Status`. */
  readonly status_color: string | null
  /** A Vendor */
  readonly purchase_vendor?: FleetioVendorMini | null
  /** A Vehicle */
  readonly linked_vehicle?: FleetioVehicleMini
  /** A Contact */
  readonly assigned_contact?: FleetioContactMini | null
  readonly attachment_permissions: FleetioAttachmentPermissions | null
  /** The URL of the Equipment's default image/profile photo, if any. */
  readonly default_image_url: string | null
  /** The type of assetable object. */
  readonly assetable_type: string | null
  /** The number of `Comments` associated with this Equipment. */
  readonly comments_count: number
  /** The number of documents associated with this Equipment. */
  readonly documents_count: number
  /** The number of images associated with this Equipment. */
  readonly images_count: number
  /** Indicates whether this Equipment is being watched. */
  readonly is_watched: boolean
  /** The number of users watching this Equipment. */
  readonly watchers_count: number
}

export interface FleetioEquipmentFilter {
  readonly brand?: FleetioLikeOrEqFilter
  readonly name?: FleetioLikeOrEqFilter
  readonly model?: FleetioLikeOrEqFilter
  readonly serial_number?: FleetioLikeOrEqFilter
  readonly labels?: FleetioIncludeFilter
  readonly current_location_entry_id?: FleetioEqFilter
  readonly group_id?: FleetioEqFilter
  readonly in_service_date?: FleetioEqOrRangeFilter
  readonly out_of_service_date?: FleetioEqOrRangeFilter
  readonly purchase_date?: FleetioEqOrRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioEquipmentSort {
  readonly in_service_date?: FleetioSortDirection
  readonly out_of_service_date?: FleetioSortDirection
  readonly purchase_date?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

/** Parameters used to create a new Equipment */
export interface FleetioEquipmentCreateInput {
  /** The name for this Equipment. */
  readonly name: string
  /** The name of the brand which makes this Equipment. */
  readonly brand?: string
  /** The model name of this Equipment. */
  readonly model?: string
  /** The serial number of this Equipment. */
  readonly serial_number?: string
  readonly type_id: number
  readonly status_id: number
  readonly group_id?: number | null
  /** A pipe delimited group hierarchy. */
  readonly group_hierarchy?: string
  readonly purchase_vendor_id?: number | null
  /** The price at which the Equipment was purchased. */
  readonly purchase_price?: number
  /** We recommend using ISO-8601 formatted dates to avoid ambiguity. */
  readonly purchase_date?: string
  /** The date on which the Equipment warranty expires. */
  readonly warranty_expiration_date?: string
  /** Any comments about the purchase of this Equipment. */
  readonly purchase_comments?: string
  /** We recommend using ISO-8601 formatted dates to avoid ambiguity. */
  readonly in_service_date?: string
  /** The estimated duration in months of the service life for this Equipment. */
  readonly estimated_service_life?: number
  /** The estimated resale price of this Equipment. */
  readonly estimated_resale_price?: number
  /** We recommend using ISO-8601 formatted dates to avoid ambiguity. */
  readonly out_of_service_date?: string
  readonly linked_vehicle_id?: number | null
  readonly assignee_id?: number | null
  /** The default image URL for this Equipment. */
  readonly default_image?: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
}

export interface FleetioEquipmentCreated {
  readonly id: number
  readonly created_at: string
  readonly updated_at: string
  /** The ID of the `Account` this Equipment belongs to. */
  readonly account_id: number
  /** The name for this Equipment. */
  readonly name: string
  /** The name of the brand which makes this Equipment. */
  readonly brand: string | null
  /** The model name of this Equipment. */
  readonly model: string | null
  /** The serial number of this Equipment. */
  readonly serial_number: string | null
  readonly equipment_type_id: number
  readonly equipment_status_id: number
  readonly group_id: number | null
  readonly purchase_vendor_id: number | null
  /** The purchase price in cents. */
  readonly purchase_price_cents: number | null
  /** The date on which the Equipment was purchased. */
  readonly purchase_date: string | null
  /** The date on which the Equipment warranty expires. */
  readonly warranty_expiration_date: string | null
  /** Any comments about the purchase of this Equipment. */
  readonly purchase_comments: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The date on which the Equipment was put into service. */
  readonly in_service_date: string | null
  /** The estimated duration in months of the service life for this Equipment. */
  readonly estimated_service_life: number | null
  /** The estimated date on which the Equipment will be retired from service. */
  readonly out_of_service_date: string | null
  /** The date and time at which the Equipment was archived. */
  readonly archived_at: string | null
  readonly current_location_entry_id?: number | null
  /** The number of users watching this Equipment. */
  readonly watchers_count: number
  readonly watchable_options?: Readonly<Record<string, unknown>>
  /** Whether or not to bulk watch this Equipment. */
  readonly bulk_watch_record?: boolean
  /** The estimated resale price of this Equipment. */
  readonly estimated_resale_price_cents?: number | null
  /** A list of any labels applied to this Equipment. */
  readonly label_list?: readonly string[]
  /** Whether or not to skip automatic watchers callbacks on this Equipment. */
  readonly skip_automatic_watchers_callbacks?: boolean
  /** The number of `Comments` on this Equipment. */
  readonly comments_count: number
  /** The number of documents attached to this Equipment. */
  readonly documents_count: number
  /** The number of images attached to this Equipment. */
  readonly images_count: number
}

export type FleetioEquipmentUpdateInput = Partial<FleetioEquipmentCreateInput>

/** An Equipment Status */
export interface FleetioEquipmentStatus {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Equipment Status. */
  readonly name: string
  /** Indicates whether this is the default Equipment Status applied to new Equipment. */
  readonly default: boolean
  /** The color displayed in the UI for this Equipment Status. */
  readonly color: string | null
  /** The position of this Equipment Status in the list of Equipment Statuses. */
  readonly position: number
}

export interface FleetioEquipmentStatusFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly color?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioEquipmentStatusSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioEquipmentStatusCreateInput {
  /** The name of the Equipment Status. */
  readonly name: string
  /** Indicates whether this is the default Equipment Status applied to new Equipment. */
  readonly default?: boolean
  /** The color displayed in the UI for this Equipment Status. */
  readonly color?: string
}

export type FleetioEquipmentStatusUpdateInput = Partial<FleetioEquipmentStatusCreateInput>

/** An Equipment Type */
export interface FleetioEquipmentType {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Equipment Type. */
  readonly name: string
  /** Indicates whether this is the default Equipment Type applied to new `Equipment`. */
  readonly default: boolean
}

export interface FleetioEquipmentTypeFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioEquipmentTypeSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioEquipmentTypeCreateInput {
  /** The name of the Equipment Type. */
  readonly name: string
  /** Indicates whether this is the default Equipment Type applied to new `Equipment`. */
  readonly default?: boolean
}

export type FleetioEquipmentTypeUpdateInput = Partial<FleetioEquipmentTypeCreateInput>
