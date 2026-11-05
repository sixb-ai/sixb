import type { FleetioComment } from "./comments"
import type {
  FleetioEqFilter,
  FleetioEqOrRangeFilter,
  FleetioIncludeFilter,
  FleetioLikeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type {
  FleetioAttachmentPermissions,
  FleetioAutoIntegrateRepairOrderStatus,
  FleetioContactMini,
  FleetioCurrentLocationEntry,
  FleetioDiscountType,
  FleetioFaultRule,
  FleetioInspectionItem,
  FleetioMeasurementSystem,
  FleetioMeterUnit,
  FleetioVehicleDriver,
  FleetioVehicleMeterEntry,
  FleetioVehicleSpecs,
  FleetioVendorMini,
  FleetioVolumeUnit,
} from "./shared"

export type FleetioVehicleOwnership =
  | "owned"
  | "leased"
  | "rented"
  | "customer"
  | "financed"
  | "rent_to_own"

export interface FleetioVehicleJobAssignment {
  /** The ID of the job assignment. */
  readonly id?: number
  /** The date and time when the job assignment started. */
  readonly started_at?: string
  /** The date and time when the job assignment ended, if applicable. */
  readonly ended_at?: string | null
  readonly job?: { readonly id?: number; readonly name?: string; readonly number?: string } | null
}

/** A Vehicle */
export interface FleetioVehicle {
  readonly id?: number
  readonly account_id?: number
  /** The iso8601 date and time at which the vehicle was archived, for an archived vehicle. */
  readonly archived_at?: string | null
  readonly fuel_type_id?: number | null
  /** The name of the `Fuel Type` associated with this vehicle. */
  readonly fuel_type_name?: string | null
  readonly fuel_volume_units?: FleetioVolumeUnit
  readonly group_id?: number | null
  /** The name of the `Group` associated with this vehicle, for vehicles associated with a group. */
  readonly group_name?: string | null
  /** This vehicle's name. */
  readonly name?: string
  readonly ownership?: FleetioVehicleOwnership
  readonly current_location_entry_id?: number | null
  readonly system_of_measurement?: FleetioMeasurementSystem
  /** This vehicles `Vehicle Type` id. */
  readonly vehicle_type_id?: number
  /** The name of the `Vehicle Type` associated with this Vehicle. */
  readonly vehicle_type_name?: string
  /** Indicates whether this Vehicle record is Sample Data. */
  readonly is_sample?: boolean
  /** The id of the `Vehicle Status` of this vehicle. */
  readonly vehicle_status_id?: number
  /** The name of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_name?: string
  /** The hex color code of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_color?: string | null
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly primary_meter_unit?: FleetioMeterUnit | null
  /** The current value of the primary meter for this Vehicle. */
  readonly primary_meter_value?: string | null
  /** The date and time at which the primary meter was last updated. */
  readonly primary_meter_date?: string | null
  /** The average number of units of the primary meter used per day. */
  readonly primary_meter_usage_per_day?: string | null
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly secondary_meter_unit?: FleetioMeterUnit | null
  /** The current value of the secondary meter for this Vehicle. */
  readonly secondary_meter_value?: string | null
  /** The date and time at which the secondary meter was last updated. */
  readonly secondary_meter_date?: string | null
  /** The average number of units of the secondary meter used per day. */
  readonly secondary_meter_usage_per_day?: string | null
  /** The meter value at which this Vehicle was put into service. */
  readonly in_service_meter_value?: string | null
  /** The date on which this Vehicle was put into service. */
  readonly in_service_date?: string | null
  /** The meter value at which this Vehicle was or will be retired. */
  readonly out_of_service_meter_value?: string | null
  /** The date on which this Vehicle was or will be retired. */
  readonly out_of_service_date?: string | null
  /** The estimated number of months this Vehicle will be in service. */
  readonly estimated_service_months?: number | null
  /** The estimated number of miles before which this Vehicle will be replaced. */
  readonly estimated_replacement_mileage?: string | null
  /** The estimated resale price of this Vehicle in cents. */
  readonly estimated_resale_price_cents?: number | null
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
  /** The number of `Issues` this Vehicle is associated with. */
  readonly issues_count?: number
  /** The number of `Work Orders` this Vehicle is associated with. */
  readonly work_orders_count?: number
  readonly labels?: readonly { readonly id?: number; readonly name?: string }[]
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
  /** The URL of a small-sized version of the default image for this Vehicle. */
  readonly default_image_url_small?: string | null
  /** Any External IDs associated with this Vehicle. */
  readonly external_ids?: Readonly<Record<string, unknown>>
  /** Whether this Vehicle has Auto Integrate enabled for it. */
  readonly ai_enabled?: boolean
  /** Assetable type for Vehicle is always `Vehicle` for vehicles. */
  readonly assetable_type?: "Vehicle"
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The id of the `Axle Configuration` of this vehicle. */
  readonly axle_config_id?: number | null
  readonly driver?: FleetioVehicleDriver
  readonly specs?: FleetioVehicleSpecs
  /** The name of the primary meter for this Vehicle. */
  readonly meter_name?: string
  /** The name of the secondary meter for this Vehicle. */
  readonly secondary_meter_name?: string
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
  /** The current job assignment for this Vehicle, if any. */
  readonly job_assignment?: FleetioVehicleJobAssignment | null
  /** The number of inspection schedules this Vehicle is associated with. */
  readonly inspection_schedules_count?: number
  /** The URL of the default image for this Vehicle. */
  readonly default_image_url?: string | null
  /** The URL of a medium-sized version of the default image for this Vehicle. */
  readonly default_image_url_medium?: string | null
  /** The URL of a large-sized version of the default image for this Vehicle. */
  readonly default_image_url_large?: string | null
  /** The current location of the associated object. */
  readonly current_location_entry?: FleetioCurrentLocationEntry | null
  readonly created_at?: string
  readonly updated_at?: string
  readonly comments?: readonly FleetioComment[]
  readonly documents_including_nested_resources_count?: number
  readonly warranties_count?: number
  readonly warranties_active_count?: number
}

/** A Vehicle */
export interface FleetioVehicleSummary {
  readonly id?: number
  readonly account_id?: number
  /** The iso8601 date and time at which the vehicle was archived, for an archived vehicle. */
  readonly archived_at?: string | null
  readonly fuel_type_id?: number | null
  /** The name of the `Fuel Type` associated with this vehicle. */
  readonly fuel_type_name?: string | null
  readonly fuel_volume_units?: FleetioVolumeUnit
  readonly group_id?: number | null
  /** The name of the `Group` associated with this vehicle, for vehicles associated with a group. */
  readonly group_name?: string | null
  /** This vehicle's name. */
  readonly name?: string
  readonly ownership?: FleetioVehicleOwnership
  readonly current_location_entry_id?: number | null
  readonly system_of_measurement?: FleetioMeasurementSystem
  /** This vehicles `Vehicle Type` id. */
  readonly vehicle_type_id?: number
  /** The name of the `Vehicle Type` associated with this Vehicle. */
  readonly vehicle_type_name?: string
  /** Indicates whether this Vehicle record is Sample Data. */
  readonly is_sample?: boolean
  /** The id of the `Vehicle Status` of this vehicle. */
  readonly vehicle_status_id?: number
  /** The name of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_name?: string
  /** The hex color code of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_color?: string | null
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly primary_meter_unit?: FleetioMeterUnit | null
  /** The current value of the primary meter for this Vehicle. */
  readonly primary_meter_value?: string | null
  /** The date and time at which the primary meter was last updated. */
  readonly primary_meter_date?: string | null
  /** The average number of units of the primary meter used per day. */
  readonly primary_meter_usage_per_day?: string | null
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly secondary_meter_unit?: FleetioMeterUnit | null
  /** The current value of the secondary meter for this Vehicle. */
  readonly secondary_meter_value?: string | null
  /** The date and time at which the secondary meter was last updated. */
  readonly secondary_meter_date?: string | null
  /** The average number of units of the secondary meter used per day. */
  readonly secondary_meter_usage_per_day?: string | null
  /** The meter value at which this Vehicle was put into service. */
  readonly in_service_meter_value?: string | null
  /** The date on which this Vehicle was put into service. */
  readonly in_service_date?: string | null
  /** The meter value at which this Vehicle was or will be retired. */
  readonly out_of_service_meter_value?: string | null
  /** The date on which this Vehicle was or will be retired. */
  readonly out_of_service_date?: string | null
  /** The estimated number of months this Vehicle will be in service. */
  readonly estimated_service_months?: number | null
  /** The estimated number of miles before which this Vehicle will be replaced. */
  readonly estimated_replacement_mileage?: string | null
  /** The estimated resale price of this Vehicle in cents. */
  readonly estimated_resale_price_cents?: number | null
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
  /** The number of `Issues` this Vehicle is associated with. */
  readonly issues_count?: number
  /** The number of `Work Orders` this Vehicle is associated with. */
  readonly work_orders_count?: number
  readonly labels?: readonly { readonly id?: number; readonly name?: string }[]
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
  /** The URL of a small-sized version of the default image for this Vehicle. */
  readonly default_image_url_small?: string | null
  /** Any External IDs associated with this Vehicle. */
  readonly external_ids?: Readonly<Record<string, unknown>>
  /** Whether this Vehicle has Auto Integrate enabled for it. */
  readonly ai_enabled?: boolean
  /** Assetable type for Vehicle is always `Vehicle` for vehicles. */
  readonly assetable_type?: "Vehicle"
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The id of the `Axle Configuration` of this vehicle. */
  readonly axle_config_id?: number | null
  /** A Contact */
  readonly driver?: FleetioContactMini | null
  readonly specs?: FleetioVehicleSpecs
  readonly created_at?: string
  readonly updated_at?: string
}

export interface FleetioVehicleFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly vin?: FleetioLikeOrEqFilter
  readonly license_plate?: FleetioLikeOrEqFilter
  readonly external_id?: FleetioLikeFilter
  readonly labels?: FleetioIncludeFilter
  readonly group_id?: FleetioEqFilter
  readonly vehicle_status_id?: FleetioEqFilter
  readonly vehicle_type_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleSort {
  readonly name?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioVehiclePurchaseDetailAttributes {
  /** A comment about this Vehicle's purchase. */
  readonly comment?: string
  /** The date and time at which this Vehicle was purchased. */
  readonly date?: string
  /** The price of this Vehicle at the time of purchase. */
  readonly price?: number
  /** The ID of the `Vendor` from which this vehicle was purchased. */
  readonly vendor_id?: number
  /** The date and time at which this Vehicle's warranty expires. */
  readonly warranty_expiration_date?: string
  /** The meter value at which this Vehicle's warranty expires. */
  readonly warranty_expiration_meter_value?: number
  /** The meter value at the time of purchase. */
  readonly "meter_entry_attributes.value"?: number
  /** Indicates whether the `Meter Entry` created by passing `meter_entry_attributes.value` should be considered void. */
  readonly "meter_entry_attributes.void"?: boolean
}

export interface FleetioVehicleCreateInputSpecs {
  /** The base towing capacity of the Vehicle. */
  readonly base_towing_capacity?: number
  /** The length of the Vehicle's bed. */
  readonly bed_length?: number
  /** The subtype of the Vehicle body. */
  readonly body_subtype?: string
  /** The body type of the Vehicle. */
  readonly body_type?: string
  /** The brake system used in the Vehicle. */
  readonly brake_system?: string
  /** Cargo volume of the Vehicle. */
  readonly cargo_volume?: number
  /** The curb weight of the Vehicle. */
  readonly curb_weight?: number
  /** The drive type of the Vehicle. */
  readonly drive_type?: string
  /** Aspiration type of the engine. */
  readonly engine_aspiration?: string
  /** Block type of the engine. */
  readonly engine_block_type?: string
  /** Bore size of the engine. */
  readonly engine_bore?: number
  /** Brand of the Vehicle's engine. */
  readonly engine_brand?: string
  /** Camshaft type of the engine. */
  readonly engine_cam_type?: string
  /** Compression ratio of the engine. */
  readonly engine_compression?: number
  /** Number of engine cylinders. */
  readonly engine_cylinders?: number
  /** Description of the Vehicle's engine. */
  readonly engine_description?: string
  /** The displacement of the Vehicle's engine. */
  readonly engine_displacement?: number
  /** Stroke length of the engine. */
  readonly engine_stroke?: number
  /** Number of engine valves. */
  readonly engine_valves?: number
  /** The EPA city fuel economy rating. */
  readonly epa_city?: number
  /** The combined EPA fuel economy rating. */
  readonly epa_combined?: number
  /** The EPA highway fuel economy rating. */
  readonly epa_highway?: number
  /** The recommended PSI for front tires. */
  readonly front_tire_psi?: number
  /** The type of front tires used in the Vehicle. */
  readonly front_tire_type?: string
  /** The front track width of the Vehicle. */
  readonly front_track_width?: number
  /** The diameter of the front wheels. */
  readonly front_wheel_diameter?: string
  /** Fuel induction method. */
  readonly fuel_induction?: string
  /** Fuel quality required for the engine. */
  readonly fuel_quality?: string
  /** The fuel tank capacity of the Vehicle. */
  readonly fuel_tank_capacity?: number
  /** The capacity of a second fuel tank, if applicable. */
  readonly fuel_tank_2_capacity?: number
  /** The Gross Vehicle Weight Rating (GVWR). */
  readonly gross_vehicle_weight_rating?: number
  /** The ground clearance of the Vehicle. */
  readonly ground_clearance?: number
  /** The height of the Vehicle. */
  readonly height?: number
  /** Interior volume of the Vehicle. */
  readonly interior_volume?: number
  /** The length of the Vehicle. */
  readonly length?: number
  /** Maximum horsepower produced by the engine. */
  readonly max_hp?: number
  /** The maximum payload capacity of the Vehicle. */
  readonly max_payload?: number
  /** Maximum torque produced by the engine. */
  readonly max_torque?: number
  /** Manufacturer's Suggested Retail Price (MSRP). */
  readonly msrp?: number
  /** Oil capacity of the engine. */
  readonly oil_capacity?: number
  /** Passenger volume of the Vehicle. */
  readonly passenger_volume?: string
  /** The type of rear axle used in the Vehicle. */
  readonly rear_axle_type?: string
  /** The recommended PSI for rear tires. */
  readonly rear_tire_psi?: number
  /** The type of rear tires used in the Vehicle. */
  readonly rear_tire_type?: string
  /** The rear track width of the Vehicle. */
  readonly rear_track_width?: number
  /** The diameter of the rear wheels. */
  readonly rear_wheel_diameter?: string
  /** Redline RPM of the engine. */
  readonly redline_rpm?: string
  /** Brand of the Vehicle's transmission. */
  readonly transmission_brand?: string
  /** Description of the Vehicle's transmission. */
  readonly transmission_description?: string
  /** Number of gears in the transmission. */
  readonly transmission_gears?: number
  /** Type of transmission. */
  readonly transmission_type?: string
  /** The wheelbase of the Vehicle. */
  readonly wheelbase?: number
  /** The width of the Vehicle. */
  readonly width?: number
}

export interface FleetioVehicleCreateInput {
  /** The color of this Vehicle. */
  readonly color?: string
  /** The default image to assign to this Vehicle. */
  readonly default_image?: { readonly file_url?: string }
  /** The ID of the `Fuel Type` associated with this Vehicle. */
  readonly fuel_type_id?: number
  readonly fuel_volume_units?: FleetioVolumeUnit
  /** The id of the `Group` for the vehicle */
  readonly group_id?: number
  /** A pipe delimited group hierarchy. */
  readonly group_hierarchy?: string
  /** The `label_id`(s) of any Labels to assign to this Vehicle. */
  readonly label_ids?: readonly number[]
  /** The license plate number of this Vehicle. */
  readonly license_plate?: string
  /** The name of this Vehicle's manufacturer. */
  readonly make?: string
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly primary_meter_unit: FleetioMeterUnit | null
  /** The name of the model of this Vehicle. */
  readonly model?: string
  /** A name to assign to this Vehicle. */
  readonly name: string
  readonly ownership?: FleetioVehicleOwnership
  /** The month in which this Vehicle's registration expires. */
  readonly registration_expiration_month?: number
  /** The state, province, or territory in which this Vehicle is registered. */
  readonly registration_state?: string
  /** Indicates whether or not this Vehicle has a secondary meter. */
  readonly secondary_meter?: boolean
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly secondary_meter_unit?: FleetioMeterUnit | null
  readonly system_of_measurement?: FleetioMeasurementSystem
  /** The trim level of this Vehicle. */
  readonly trim?: string
  /** The ID of the `Vehicle Status` for this Vehicle. */
  readonly vehicle_status_id: number
  /** The ID of the `Vehicle Type` for this Vehicle. */
  readonly vehicle_type_id: number
  /** The Vehicle Identification Number of this Vehicle. */
  readonly vin?: string
  /** This Vehicle's model year. */
  readonly year?: number
  /** The `vehicle_id`(s) of any Vehicles to link to this Vehicle. */
  readonly linked_vehicle_ids?: readonly number[]
  readonly purchase_detail?: FleetioVehiclePurchaseDetailAttributes
  /** Any External IDs associated with this Vehicle. */
  readonly external_ids?: Readonly<Record<string, unknown>>
  /** The name of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_name?: string
  /** The name of the `Vehicle Type` associated with this Vehicle. */
  readonly vehicle_type_name?: string
  /** The date on which this Vehicle was put into service. */
  readonly in_service_date?: string
  /** The meter value at which this Vehicle was put into service. */
  readonly in_service_meter_value?: string
  /** The estimated number of months this Vehicle will be in service. */
  readonly estimated_service_months?: number
  /** The estimated number of miles before which this Vehicle will be replaced. */
  readonly estimated_replacement_mileage?: number
  /** The estimated resale price of this Vehicle. */
  readonly estimated_resale_price?: number
  /** The date on which this Vehicle was or will be retired. */
  readonly out_of_service_date?: string
  /** The meter value at which this Vehicle was or will be retired. */
  readonly out_of_service_meter_value?: string
  readonly specs?: FleetioVehicleCreateInputSpecs
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
}

export interface FleetioVehicleUpdateInput {
  /** The color of this Vehicle. */
  readonly color?: string
  /** The default image to assign to this Vehicle. */
  readonly default_image?: { readonly file_url?: string }
  /** The ID of the `Fuel Type` associated with this Vehicle. */
  readonly fuel_type_id?: number
  readonly fuel_volume_units?: FleetioVolumeUnit
  readonly group_id?: number
  /** A pipe delimited group hierarchy. */
  readonly group_hierarchy?: string
  /** The `label_id`(s) of any Labels to assign to this Vehicle. */
  readonly label_ids?: readonly number[]
  /** The license plate number of this Vehicle. */
  readonly license_plate?: string
  /** The name of this Vehicle's manufacturer. */
  readonly make?: string
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly meter_unit?: FleetioMeterUnit | null
  /** The name of the model of this Vehicle. */
  readonly model?: string
  /** A name to assign to this Vehicle. */
  readonly name?: string
  readonly ownership?: FleetioVehicleOwnership
  /** The month in which this Vehicle's registration expires. */
  readonly registration_expiration_month?: number
  /** The state, province, or territory in which this Vehicle is registered. */
  readonly registration_state?: string
  /** Indicates whether or not this Vehicle has a secondary meter. */
  readonly secondary_meter?: boolean
  /** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
  readonly secondary_meter_unit?: FleetioMeterUnit | null
  readonly system_of_measurement?: FleetioMeasurementSystem
  /** The trim level of this Vehicle. */
  readonly trim?: string
  readonly vehicle_status_id?: number
  readonly vehicle_type_id?: number
  /** The Vehicle Identification Number of this Vehicle. */
  readonly vin?: string
  /** This Vehicle's model year. */
  readonly year?: number
  /** The `vehicle_id`(s) of any Vehicles to link to this Vehicle. */
  readonly linked_vehicle_ids?: readonly number[]
  readonly purchase_detail_attributes?: FleetioVehiclePurchaseDetailAttributes
  /** Any External IDs associated with this Vehicle. */
  readonly external_ids?: Readonly<Record<string, unknown>>
  /** The name of the `Vehicle Status` associated with this Vehicle. */
  readonly vehicle_status_name?: string
  /** The name of the `Vehicle Type` associated with this Vehicle. */
  readonly vehicle_type_name?: string
  /** The date on which this Vehicle was put into service. */
  readonly in_service_date?: string
  /** The meter value at which this Vehicle was put into service. */
  readonly in_service_meter?: number
  /** The estimated number of months this Vehicle will be in service. */
  readonly estimated_service_months?: number
  /** The estimated number of miles before which this Vehicle will be replaced. */
  readonly estimated_replacement_mileage?: number
  /** The estimated resale price of this Vehicle. */
  readonly estimated_resale_price?: number
  /** The date on which this Vehicle was or will be retired. */
  readonly out_of_service_date?: string
  /** The meter value at which this Vehicle was or will be retired. */
  readonly out_of_service_meter?: number
  readonly specs_attributes?: FleetioVehicleCreateInputSpecs
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
}

/** A Vehicle Status */
export interface FleetioVehicleStatus {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Vehicle Status. */
  readonly name: string
  /** Whether this is the default Vehicle Status for new `Vehicles`. */
  readonly default: boolean
  /** The color of the Vehicle Status shown in the UI. */
  readonly color: string | null
  /** The position of this Vehicle Status in the list of Vehicle Statuses. */
  readonly position: number | null
}

export interface FleetioVehicleStatusFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly color?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleStatusSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioVehicleStatusCreateInput {
  /** The name of the Vehicle Status. */
  readonly name: string
  /** Whether this should be the default Vehicle Status for new `Vehicles`. */
  readonly default?: boolean
}

export type FleetioVehicleStatusUpdateInput = Partial<FleetioVehicleStatusCreateInput>

/** A Vehicle Type */
export interface FleetioVehicleType {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Vehicle Type. */
  readonly name: string
  /** Whether this Vehicle Type is the default applied to new `Vehicles`. */
  readonly default: boolean
  /** The number of unarchived `Vehicles` that are of this Vehicle Type. */
  readonly unarchived_vehicles_count: number
  /** The total number of `Vehicles` that are of this Vehicle Type. */
  readonly vehicles_count: number
}

export interface FleetioVehicleTypeFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleTypeSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioVehicleTypeCreateInput {
  /** The name of the Vehicle Type. */
  readonly name: string
  /** Whether this Vehicle Type should be the default applied to new `Vehicles`. */
  readonly default?: boolean
}

export type FleetioVehicleTypeUpdateInput = Partial<FleetioVehicleTypeCreateInput>

export interface FleetioArchivedVehicleFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly vin?: FleetioLikeOrEqFilter
  readonly license_plate?: FleetioLikeOrEqFilter
  readonly external_id?: FleetioLikeFilter
  readonly archived_at?: FleetioRangeFilter
}

export interface FleetioArchivedVehicleSort {
  readonly archived_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioVehicleFuelEntryFilter {
  readonly external_id?: FleetioLikeOrEqFilter
  readonly vendor_id?: FleetioEqFilter
  readonly date?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleFuelEntrySort {
  readonly id?: FleetioSortDirection
  readonly date?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioLinkedVehicleFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly vin?: FleetioLikeOrEqFilter
  readonly license_plate?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioLinkedVehicleSort {
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioVehicleMeterEntryFilter {
  readonly category?: FleetioIncludeFilter
  readonly meterable_type?: FleetioIncludeFilter
  readonly meterable_id?: FleetioEqFilter
  readonly date?: FleetioEqOrRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleMeterEntrySort {
  readonly id?: FleetioSortDirection
  readonly date?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

/** A Service Entry */
export interface FleetioVehicleServiceEntrySummary {
  /** The Auto Integrate `Repair Order` status for this Service Entry. */
  readonly auto_integrate_repair_order_status: FleetioAutoIntegrateRepairOrderStatus | null
  /** The number of images associated with this Service Entry. */
  readonly images_count: number
  /** The number of documents associated with this Service Entry. */
  readonly documents_count: number
  /** The number of comments associated with this Service Entry. */
  readonly comments_count: number
  readonly id: number
  /** The date and time at which the Service Entry was completed. */
  readonly completed_at: string | null
  /** A reference number for this Service Entry. */
  readonly reference: string | null
  /** The date and time at which the Service Entry was started. */
  readonly started_at: string | null
  /** The status of this Service Entry. */
  readonly status: "pending" | "completed"
  /** General notes for this Service Entry. */
  readonly general_notes: string | null
  readonly vehicle_id: number
  readonly vendor_id: number | null
  readonly work_order_id: number | null
  /** Indicates whether or not this Service Entry is a sample. */
  readonly is_sample: boolean
  /** A Meter Entry */
  readonly primary_meter_entry: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly secondary_meter_entry?: FleetioVehicleMeterEntry | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  /** A Vendor */
  readonly vendor?: FleetioVendorMini | null
  /** The type of discount applied to this record. */
  readonly discount_type?: FleetioDiscountType | null
  /** The discount percentage. */
  readonly discount_percentage?: string | null
  /** The primary tax type. */
  readonly tax_1_type?: string
  /** The primary tax percentage. */
  readonly tax_1_percentage?: string | null
  /** The secondary tax type. */
  readonly tax_2_type?: string | null
  /** The secondary tax percentage. */
  readonly tax_2_percentage?: string | null
  /** The pre-tax subtotal amount for labor. */
  readonly labor_subtotal_cents?: number
  /** The pre-tax subtotal amount for parts. */
  readonly parts_subtotal_cents?: number
  /** The fees amount. */
  readonly fees_cents?: number
  /** The pre-tax subtotal amount. */
  readonly subtotal_cents?: number
  /** The discount amount. */
  readonly discount_cents?: number
  /** The primary tax amount. */
  readonly tax_1_cents?: number
  /** The secondary tax amount. */
  readonly tax_2_cents?: number
  /** The total amount. */
  readonly total_amount_cents?: number
}

export interface FleetioVehicleServiceEntryFilter {
  readonly reference?: FleetioLikeOrEqFilter
  readonly status?: FleetioIncludeFilter
  readonly labels?: FleetioIncludeFilter
  readonly completed_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleServiceEntrySort {
  readonly id?: FleetioSortDirection
  readonly completed_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
}

/** A Vehicle Assignment */
export interface FleetioVehicleAssignmentOnVehicleSummary {
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  readonly id: number
  /** The id of the vehicle associated with this Vehicle Assignment. */
  readonly vehicle_id: number
  /** The id of the contact associated with this Vehicle Assignment. */
  readonly contact_id: number
  /** The date and time of this Vehicle Assignment. */
  readonly started_at: string | null
  /** The date and time of this Vehicle Assignment ending. */
  readonly ended_at: string | null
  /** Whether this Vehicle Assignment is current/active. */
  readonly current: boolean
  /** Whether this Vehicle Assignment is set to take place in the future. */
  readonly future: boolean
  /** The meter value at the start of this Vehicle Assignment. */
  readonly starting_meter_entry_value: number | null
  /** The meter value at the end of this Vehicle Assignment. */
  readonly ending_meter_entry_value: number | null
  /** The number of comments on this Vehicle Assignment. */
  readonly comments_count: number
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** A Contact */
  readonly contact: FleetioContactMini | null
}

export interface FleetioVehicleAssignmentOnVehicleFilter {
  readonly contact_id?: FleetioEqFilter
  readonly ended_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleAssignmentOnVehicleSort {
  readonly started_at?: FleetioSortDirection
  readonly ended_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

/** An Issue */
export interface FleetioVehicleIssueSummary {
  readonly id: number
  /** A unique identifier for the Issue. */
  readonly number: string
  /** The Issue's current state. */
  readonly state: "Open" | "Closed" | "Resolved"
  readonly created_at: string
  readonly updated_at: string
  /** The name of the Issue. */
  readonly name: string
  /** A longer description of the Issue. */
  readonly description: string | null
  /** The date and time at which the issue was reported. */
  readonly reported_at: string | null
  /** The date and time at which the issue was resolved. */
  readonly resolved_at: string | null
  /** The id of the `User` who resolved the Issue. */
  readonly resolved_by_id?: number | null
  /** The date and time at which the issue was closed. */
  readonly closed_at?: string | null
  /** The id of the `User` who closed the Issue. */
  readonly closed_by_id?: number | null
  /** The date and time at which the issue was reopened. */
  readonly reopened_at?: string | null
  /** The id of the `User` who reopened the Issue. */
  readonly reopened_by_id?: number | null
  /** The id of the resolvable_type which can resolve this Issue. */
  readonly resolvable_id: number | null
  /** The type of the object which can resolve this Issue. */
  readonly resolvable_type: "ServiceEntry" | "WorkOrder" | null
  /** The date on which this Issue should be resolved by. */
  readonly due_date: string | null
  /** The primary meter value at which this Issue should be resolved by. */
  readonly due_primary_meter_value: string | null
  /** The secondary meter value at which this Issue should be resolved by. */
  readonly due_secondary_meter_value: number | null
  /** Indicates whether the Issue is overdue. */
  readonly overdue: boolean
  /** The type of asset this Issue applies to. */
  readonly asset_type: "Vehicle" | "Equipment"
  /** The id of the associated `InspectionForm`, if any. */
  readonly inspection_form_id: number | null
  /** The id of the associated `SubmittedInspectionForm`, if any. */
  readonly submitted_inspection_form_id: number | null
  /** The id of the associated `Fault` if any. */
  readonly fault_id: number | null
  /** The external ID for this Issue. */
  readonly external_id: string | null
  /** The count of watchers for this Issue. */
  readonly watchers_count: number
  /** The count of comments for this Issue. */
  readonly comments_count: number
  /** The count of documents for this Issue. */
  readonly documents_count: number
  /** The count of images for this Issue. */
  readonly images_count: number
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A Contact */
  readonly reported_by?: FleetioContactMini | null
  /** A Fault Rule */
  readonly fault_rule?: FleetioFaultRule
  readonly labels?: readonly { readonly id?: number; readonly name?: string }[]
  readonly inspection_items?: readonly FleetioInspectionItem[]
  readonly assigned_contacts?: readonly (FleetioContactMini | null)[]
}

export interface FleetioVehicleIssueFilter {
  readonly number?: FleetioEqFilter
  readonly reported_by_id?: FleetioEqFilter
  readonly assigned_contact_ids?: FleetioIncludeFilter
  readonly labels?: FleetioIncludeFilter
  readonly state?: FleetioIncludeFilter
  readonly due_date?: FleetioEqOrRangeFilter
  readonly resolved_at?: FleetioRangeFilter
  readonly reported_at?: FleetioRangeFilter
  readonly closed_at?: FleetioRangeFilter
  readonly reopened_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleIssueSort {
  readonly due_date?: FleetioSortDirection
  readonly resolved_at?: FleetioSortDirection
  readonly reported_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

/** A set of Purchase Details belonging to a Vehicle */
export interface FleetioPurchaseDetail {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** Any additional information about the purchase. */
  readonly comment: string | null
  /** The date of the purchase. */
  readonly date: string | null
  /** The meter value at the time of purchase. */
  readonly meter_entry_value: number | null
  /** A Meter Entry */
  readonly meter_entry?: FleetioVehicleMeterEntry | null
  readonly vehicle_id: number | null
  /** The name of the `Vehicle`. */
  readonly vehicle_name: string | null
  readonly vendor_id: number | null
  /** The name of the `Vendor`. */
  readonly vendor_name: string | null
  /** The expiration date of the warranty, if applicable. */
  readonly warranty_expiration_date: string | null
  /** The meter value at which the warranty would expire, if applicable. */
  readonly warranty_expiration_meter_value: number | null
  /** The price of the `Vehicle`. */
  readonly price: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
}
