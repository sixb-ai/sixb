import type { FleetioComment } from "./comments"
import type { FleetioServiceTask } from "./service-tasks"

export interface FleetioAttachmentPermissions {
  /** Indicates whether the user has read permission for photos. */
  readonly read_photos?: boolean
  /** Indicates whether the user has permission to manage */
  readonly manage_photos?: boolean
  /** Indicates whether the user has read permission for documents. */
  readonly read_documents?: boolean
  /** Indicates whether the user has permission to manage */
  readonly manage_documents?: boolean
}

/** A Contact */
export interface FleetioEmbeddedContact {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The Contact's email address. */
  readonly email?: string | null
  /** The Contact's full name. */
  readonly name?: string | null
  /** The Contact's first name. */
  readonly first_name?: string | null
  /** The Contact's middle name. */
  readonly middle_name?: string | null
  /** The Contact's last name. */
  readonly last_name?: string | null
  /** The number of images associated with this Contact. */
  readonly images_count?: number
  /** The number of documents associated with this Contact. */
  readonly documents_count?: number
  /** The number of comments associated with this Contact. */
  readonly comments_count?: number
  /** If this Contact belongs to a Group, this will be the Fleetio ID of that `Group`. */
  readonly group_id?: number | null
  /** If this Contact belongs to a Group, this will be the `Group`'s name. */
  readonly group_name?: string | null
  /** If this Contact belongs to a Group, this will be a pipe delimited string representing the `Group` hierarchy. */
  readonly group_hierarchy?: string | null
  /** Whether or not the Contact is a Technician. */
  readonly technician?: boolean | null
  /** Whether or not the Contact is a Vehicle Operator. */
  readonly vehicle_operator?: boolean | null
  /** Whether or not the Contact is an Employee. */
  readonly employee?: boolean | null
  /** The Contact's birth date. */
  readonly birth_date?: string | null
  /** The Contact's street address. */
  readonly street_address?: string | null
  /** The Contact's street address line 2. */
  readonly street_address_line_2?: string | null
  /** The Contact's city. */
  readonly city?: string | null
  /** The Contact's region, state, or province. */
  readonly region?: string | null
  /** The Contact's postal code, zip code, or equivalent. */
  readonly postal_code?: string | null
  /** The Contact's country. */
  readonly country?: string | null
  /** The Contact's employee number. */
  readonly employee_number?: string | null
  /** The Contact's job title. */
  readonly job_title?: string | null
  /** The Contact's driver's license class. */
  readonly license_class?: string | null
  /** The Contact's driver's license number. */
  readonly license_number?: string | null
  /** The locality which issued the Contact's license. */
  readonly license_state?: string | null
  /** The Contact's driver's license expiration date. */
  readonly license_expiration?: string | null
  /** The Contact's home phone number. */
  readonly home_phone_number?: string | null
  /** The Contact's mobile phone number. */
  readonly mobile_phone_number?: string | null
  /** The Contact's work phone number. */
  readonly work_phone_number?: string | null
  /** Any other phone number for this Contact. */
  readonly other_phone_number?: string | null
  /** When the Contact started working for the company, if applicable. */
  readonly start_date?: string | null
  /** When the Contact left or will leave the company, if applicable. */
  readonly leave_date?: string | null
  /** The Contact's hourly rate. */
  readonly hourly_labor_rate?: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** The URL of the Contact's default image/profile photo, if any. */
  readonly default_image_url?: string | null
  /** If the Contact is a Fleetio `User`, those details will be included here. */
  readonly user?: Readonly<Record<string, unknown>> | null
  readonly account_membership_id?: number | null
  /** The last date and time this Contact's associated User made an API request. */
  readonly last_api_request?: string | null
  /** The last date and time this Contact's associated User signed into the web application. */
  readonly last_web_access?: string | null
  /** The last date and time this Contact's associated User used the mobile app. */
  readonly last_mobile_app_access?: string | null
}

export interface FleetioPartCategory {
  readonly id?: number
  /** Indicates whether part is a tire or not */
  readonly tire_category?: boolean
}

/** The details of a Part at a specific Part Location. */
export interface FleetioEmbeddedPartLocationDetail {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** Whether this Part Location is active. */
  readonly active?: boolean
  /** The aisle in which the Part is located. */
  readonly aisle?: string | null
  /** How many of this Part are available at this Part Location. */
  readonly available_quantity?: number
  /** The bin in which the Part is located. */
  readonly bin?: string | null
  /** The number of Inventory Sets that this Part is included in. */
  readonly inventory_sets_count?: number
  /** Whether this Part has been used in any Work Orders. */
  readonly has_been_used_in_work_orders?: boolean | null
  /** Alias of `part_location_name`. */
  readonly name?: string
  /** The name of the Part Location for this Part. */
  readonly part_location_name?: string
  /** The ID of the Part Location for this Part. */
  readonly part_location_id?: number
  /** How many of these Parts are currently allocated to `Work Orders`. */
  readonly quantity_allocated_to_work_orders?: number | null
  /** How many of this Part are currently on order, if any. */
  readonly quantity_on_order?: number | null
  /** The lower-threshold quantity at which this Part should be reordered. */
  readonly reorder_point?: number
  /** Whether this Part will be reordered at the reorder point. */
  readonly reorder_point_enabled?: boolean
  /** The row in which the Part is located. */
  readonly row?: string | null
  /** Indicates whether inventory is tracked for this Part at this location. */
  readonly track_inventory?: boolean
  readonly available_quantity_updated_at?: string | null
  /** The date and time at which the `Part Location` was archived, if applicable. */
  readonly part_location_archived_at?: string | null
}

/** One Part Location's stock for a member of a Part's cross-reference group. */
export interface FleetioPartCrossReferenceMemberLocation {
  readonly id: number
  readonly part_id: number
  readonly part_location_id: number
  /** The name of the Part Location for this member. */
  readonly part_location_name: string
  /** How many of this member are available at this Part Location. */
  readonly available_quantity: number | null
  /** The lower-threshold quantity at which this member should be reordered at this Part Location. */
  readonly reorder_point: number | null
  /** The average unit cost for this member at this Part Location. */
  readonly average_unit_cost: number | null
  /** Always `true`; this array holds active Part Locations only. */
  readonly active: boolean
  /** Indicates whether inventory is tracked for this member at this Part Location. */
  readonly track_inventory: boolean | null
}

/** A sibling Part in the same cross-reference group. */
export interface FleetioPartCrossReferenceMember {
  readonly id: number | null
  /** The part number being used for this Part within Fleetio. */
  readonly number: string
  /** A description of this Part. */
  readonly description: string | null
  /** The name of the part category associated with this Part. */
  readonly part_category_name: string | null
  /** The name of the Part's manufacturer. */
  readonly part_manufacturer_name: string | null
  /** The part number from this Part's manufacturer. */
  readonly manufacturer_part_number: string | null
  /** The total quantity on hand for this Part. */
  readonly total_quantity: number
  /** The unit cost for this Part. */
  readonly unit_cost: number | null
  /** The measurement unit used by this Part. */
  readonly unit_cost_unit: string | null
  /** The total quantity on hand for this Part at locations the current API credentials can read. */
  readonly available_quantity: number
  readonly default_image_small_square_url: string | null
  /** This Part's rank within the shared cross-reference group. */
  readonly position: number
  /** This member's per-location stock, sorted by Part Location name. */
  readonly part_location_details?: readonly FleetioPartCrossReferenceMemberLocation[]
}

/** The type of record that the Comment will be left on. */
export type FleetioCommentableType =
  | "Contact"
  | "FleetcorCard"
  | "FuelEntry"
  | "InventoryJournalEntry"
  | "Issue"
  | "Part"
  | "PurchaseOrder"
  | "ServiceEntry"
  | "ServiceReminder"
  | "SubmittedInspectionItem"
  | "Vehicle"
  | "VehicleAssignment"
  | "Vendor"
  | "WexCard"
  | "WorkOrder"

export type FleetioDocumentableType =
  | "ServiceEntry"
  | "FuelEntry"
  | "Issue"
  | "WorkOrder"
  | "ExpenseEntry"
  | "Vehicle"

/** A Document */
export interface FleetioDocument {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of the document. */
  readonly name: string
  /** The description of the document. */
  readonly description: string
  readonly documentable_id: number
  readonly documentable_type: FleetioDocumentableType
  /** The name of the file. */
  readonly file_name: string
  /** The MIME type of the file. */
  readonly file_mime_type: string
  /** The size of the file in bytes. */
  readonly file_size: number
  /** The URL to access the file. */
  readonly file_url: string
  /** The full URL to access the file, including any necessary authentication or parameters. */
  readonly full_file_url: string
}

export type FleetioImageableType =
  | "ExpenseEntry"
  | "WorkOrder"
  | "Equipment"
  | "IssueResolution"
  | "ServiceEntry"
  | "Vendor"
  | "ServiceProgram"
  | "Issue"
  | "Contact"
  | "Part"
  | "Vehicle"
  | "FuelEntry"
  | "SubmittedInspectionItem"

export type FleetioImageMimeType =
  | "image/jpeg"
  | "image/gif"
  | "image/jif"
  | "image/jfif"
  | "image/jfi"
  | "image/tiff"
  | "image/png"
  | "image/jpg"
  | "image/jpe"
  | "image/pdf"
  | "image/webp"
  | "image/tif"
  | "image/psd"
  | "image/raw"
  | "image/arw"
  | "image/cr2"
  | "image/nrw"
  | "image/k25"
  | "image/bmp"
  | "image/dip"
  | "image/ai"
  | "image/eps"
  | "image/heif"
  | "image/heic"
  | "image/ind"
  | "image/indd"
  | "image/indt"
  | "image/jp2"
  | "image/j2k"
  | "image/jpf"
  | "image/jpx"
  | "image/jpm"
  | "image/mj2"
  | "image/x-png"

/** An Image */
export interface FleetioImage {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly imageable_id?: number
  readonly imageable_type?: FleetioImageableType
  /** The name of the image file. */
  readonly file_name?: string
  readonly file_mime_type?: FleetioImageMimeType
  /** The size of the image file in bytes. */
  readonly file_size?: number
  /** The URL to access the image file. */
  readonly file_url?: string
  /** The full URL to access the image file, including any necessary authentication or parameters. */
  readonly full_url?: string
}

/** A Meter Entry */
export interface FleetioVehicleMeterEntry {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The date and time at which this Meter Entry was automatically voided. */
  readonly auto_voided_at?: string | null
  /** A category to describe the function of this Meter Entry. */
  readonly category?: "starting" | "ending" | "nightly" | "manual" | null
  /** Indicates whether or not this Meter is a secondary Meter. */
  readonly meter_type?: "secondary" | null
  readonly meterable_id?: number | null
  /** The type of the object with which this Meter Entry is associated. */
  readonly meterable_type?:
    | "FuelEntry"
    | "Issue"
    | "PurchaseDetail"
    | "ServiceEntry"
    | "SubmittedInspectionItem"
    | "VehicleAssignment"
    | "WorkOrder"
    | null
  /** The current value of the meter. */
  readonly value?: string
  readonly vehicle_id?: number | null
  /** Indicates whether or not this Meter Entry has been voided. */
  readonly void?: boolean
  readonly type?: "GpsMeterEntry" | null
  /** The date on which this Meter Entry was recorded. */
  readonly date?: string
}

/** The type of discount applied to this record. */
export type FleetioDiscountType = "fixed" | "percentage" | null

/** The type of tax to apply to this record. */
export type FleetioTaxType = "fixed" | "percentage" | null

/** The type of parts markup applied to the record Note that this is a readonly value that will default to `percentage` for non-premium plans */
export type FleetioPartMarkupType = "fixed" | "percentage"

/** The type of labor markup applied to the record Note that this is a readonly value that will default to `percentage` for non-premium plans */
export type FleetioLaborMarkupType = "fixed" | "percentage"

/** A Contact */
export interface FleetioContactMini {
  readonly id?: number
  /** The Contact's email address. */
  readonly email?: string | null
  /** The Contact's full name. */
  readonly name?: string | null
  /** If this Contact belongs to a Group, this will be the Fleetio ID of that `Group`. */
  readonly group_id?: number | null
  /** Whether or not the Contact is an employee. */
  readonly employee?: boolean | null
  /** The employee number of the Contact. */
  readonly employee_number?: string | null
  /** The URL of the Contact's default image/profile photo, if any. */
  readonly default_image_url?: string | null
}

/** A Vehicle */
export interface FleetioVehicleMini {
  readonly id: number
  /** This vehicle's name. */
  readonly name: string
  /** The color of this Vehicle. */
  readonly color?: string | null
  /** The license plate number of this Vehicle. */
  readonly license_plate?: string | null
  /** The Vehicle Identification Number of this Vehicle. */
  readonly vin?: string | null
  /** This Vehicle's model year. */
  readonly year?: string | null
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
}

/** A Vendor */
export interface FleetioVendorMini {
  /** The name of the Vendor. */
  readonly name: string
  /** The phone number of the Vendor. */
  readonly phone: string | null
  /** The city of the Vendor. */
  readonly city: string | null
  /** The region, state, province, or territory of the Vendor. */
  readonly region: string | null
  /** The postal code or ZIP code of the Vendor. */
  readonly postal_code: string | null
  /** The country of the Vendor. */
  readonly country: string | null
  /** The external identifier of the Vendor. */
  readonly external_id: string | null
}

export interface FleetioCommentsAttributes {
  /** The title of the comment. */
  readonly title?: string
  /** The comment text. */
  readonly comment?: string
}

/** A Fault Rule */
export interface FleetioFaultRule {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The diagnostic trouble code. */
  readonly code: string
  /** A short description about the problem. */
  readonly description: string | null
  /** The priority handling for the alert. */
  readonly priority_handling: "off" | "ignore" | "critical" | null
  /** A short name for the alert. */
  readonly name: string | null
}

/** Denotes the type of the ServiceEntryLineItem */
export type FleetioServiceEntryLineItemType =
  | "ServiceEntryServiceTaskLineItem"
  | "ServiceEntryLaborLineItem"
  | "ServiceEntryPartLineItem"
  | "ServiceEntryTaxLineItem"
  | "ServiceEntryFeeLineItem"
  | "ServiceEntryTireLineItem"
  | "ServiceEntryFreeTextLineItem"

export interface FleetioEmbeddedIssueSource {
  readonly inspection_form?: {
    readonly id?: number | null
    readonly color?: string | null
    readonly title?: string | null
  }
  /** The count of inspection submissions related to the Issue. */
  readonly inspection_submissions_count?: number | null
  /** The date and time of the last inspection submission related to the Issue. */
  readonly last_inspection_submission_at?: string | null
  /** The label associated with a failed inspection item. */
  readonly failed_inspection_item_label?: string | null
}

/** An Issue */
export interface FleetioEmbeddedIssue {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** A unique identifier for the Issue. */
  readonly number: string
  /** The name of the Issue. */
  readonly name: string
  /** A summary of the Issue. */
  readonly summary: string
  /** A longer description of the Issue. */
  readonly description: string | null
  /** The Issue's current state. */
  readonly state: "Open" | "Closed" | "Resolved"
  /** The date and time at which the issue was reported. */
  readonly reported_at: string | null
  readonly reported_by_id: number | null
  /** The name of the Contact associated with the User who reported this Issue. */
  readonly reported_by_name: string | null
  readonly fault_id: number | null
  /** The date on which this Issue should be resolved by. */
  readonly due_date: string | null
  /** The meter value at which this Issue should be resolved by. */
  readonly due_meter_value: string | null
  /** The secondary meter value at which this Issue should be resolved by. */
  readonly due_secondary_meter_value: number | null
  /** Indicates whether the Issue is overdue. */
  readonly overdue: boolean
  readonly vehicle_id: number
  /** The name of the Vehicle associated with this Issue. */
  readonly vehicle_name: string
  /** Indicates whether this Issue is sample data. */
  readonly is_sample?: boolean
  /** Indicates whether this Issue was created by a workflow. */
  readonly created_by_workflow: boolean
  readonly submitted_inspection_form_id: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  readonly valid_required_custom_fields: boolean
  readonly dtc_alert_id: number | null
  /** An array of assigned Contacts related to the Issue. */
  readonly assigned_contacts: readonly (FleetioEmbeddedContact | null)[]
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** Indicates whether the Issue is watched. */
  readonly is_watched: boolean
  /** The URL to the image of the Vehicle associated with the Issue. */
  readonly vehicle_image_url: string | null
  /** The URL to a medium-sized Vehicle image associated with the Issue. */
  readonly vehicle_image_url_medium: string | null
  /** The URL to a small-sized Vehicle image associated with the Issue. */
  readonly vehicle_image_url_small: string | null
  /** The URL to a large-sized Vehicle image associated with the Issue. */
  readonly vehicle_image_url_large: string | null
  /** The count of watchers related to the Issue. */
  readonly watchers_count?: number
  /** Summative information of linked Work Orders related to the Issue. */
  readonly linked_work_orders:
    | readonly { readonly id?: number; readonly number?: number; readonly issued_at?: string }[]
    | null
  /** Inspection source information. */
  readonly source: FleetioEmbeddedIssueSource
  /** A list of the comments made on this record. */
  readonly comments?: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count?: number
  /** A list of the documents attached to this record. */
  readonly documents?: readonly FleetioDocument[]
  /** The number of documents attached to this record. */
  readonly documents_count?: number
  /** A list of the images attached to this record. */
  readonly images?: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count?: number
}

/** A Service Entry Line Item */
export interface FleetioEmbeddedServiceEntryLineItem {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** A description of the service performed for this line item. */
  readonly description: string | null
  /** Denotes the type of the ServiceEntryLineItem */
  readonly type: FleetioServiceEntryLineItemType
  /** The id of the `Service Entry` this line item belongs to. */
  readonly service_entry_id?: number
  /** For nested line items. */
  readonly service_entry_line_item_id: number | null
  /** If this line item is linked to a Service Reminder, this ID will be set. */
  readonly service_reminder_id: number | null
  /** A Service Task */
  readonly service_task?: FleetioServiceTask
  /** Any `Issues` this line item is linked to. */
  readonly issues: readonly FleetioEmbeddedIssue[]
  /** The total cost of labor for this line item. */
  readonly labor_cost?: number
  /** The total cost of parts for this line item. */
  readonly parts_cost?: number
  /** The pre-tax cost of this line item. */
  readonly subtotal?: number
  readonly vmrs_reason_for_repair: FleetioVmrsReasonForRepairCode | null
  readonly vmrs_system_group: FleetioVmrsSystemCode | null
  readonly vmrs_system: FleetioVmrsSystemCode | null
  readonly vmrs_assembly: FleetioVmrsSystemCode | null
  readonly vmrs_component: FleetioVmrsSystemCode | null
}

/** The Auto Integrate `Repair Order` status for this Service Entry. */
export type FleetioAutoIntegrateRepairOrderStatus =
  | "approved"
  | "auto_approved"
  | "awaiting_reconciliation"
  | "awaiting_invoice"
  | "awaiting_payment"
  | "completed"
  | "failed_reconciliation"
  | "invoiced"
  | "needs_approval"
  | "needs_reapproval"
  | "paid"
  | "rejected"
  | null

export type FleetioVolumeUnit = "us_gallons" | "uk_gallons" | "liters"

export type FleetioMeasurementSystem = "imperial" | "metric"

/** The measurement unit used for the Vehicle's primary, or secondary (if applicable), meter. */
export type FleetioMeterUnit = "km" | "hr" | "mi" | null

export interface FleetioVehicleSpecs {
  readonly id?: number
  /** The `Vehicle` ID these specs belong to. */
  readonly vehicle_id?: number
  readonly account_id?: number
  /** The body type of the Vehicle, if available. */
  readonly body_type?: string | null
  /** The subtype of the Vehicle body, if available. */
  readonly body_subtype?: string | null
  /** The drive type of the Vehicle, if available. */
  readonly drive_type?: string | null
  /** The brake system used in the Vehicle, if available. */
  readonly brake_system?: string | null
  /** The Manufacturer's Suggested Retail Price (MSRP) in cents, if available. */
  readonly msrp_cents?: number | null
  /** The fuel tank capacity of the Vehicle, if available. */
  readonly fuel_tank_capacity?: number | null
  /** The capacity of a second fuel tank, if available. */
  readonly fuel_tank_2_capacity?: number | null
  /** The front track width of the Vehicle, if available. */
  readonly front_track_width?: number | null
  /** The ground clearance of the Vehicle, if available. */
  readonly ground_clearance?: number | null
  /** The height of the Vehicle, if available. */
  readonly height?: number | null
  /** The length of the Vehicle, if available. */
  readonly length?: number | null
  /** The rear track width of the Vehicle, if available. */
  readonly rear_track_width?: number | null
  /** The width of the Vehicle, if available. */
  readonly width?: number | null
  /** The wheelbase of the Vehicle, if available. */
  readonly wheelbase?: number | null
  /** The recommended PSI for front tires, if available. */
  readonly front_tire_psi?: string | null
  /** The recommended PSI for rear tires, if available. */
  readonly rear_tire_psi?: string | null
  /** The base towing capacity of the Vehicle, if available. */
  readonly base_towing_capacity?: number | null
  /** The curb weight of the Vehicle, if available. */
  readonly curb_weight?: number | null
  /** The Gross Vehicle Weight Rating (GVWR), if available. */
  readonly gross_vehicle_weight_rating?: number | null
  /** The length of the Vehicle's bed, if available. */
  readonly bed_length?: string | null
  /** The maximum payload capacity of the Vehicle, if available. */
  readonly max_payload?: number | null
  /** The type of rear axle used in the Vehicle. */
  readonly rear_axle_type?: string
  /** The type of front tires used in the Vehicle. */
  readonly front_tire_type?: string
  /** The diameter of the front wheels. */
  readonly front_wheel_diameter?: string
  /** The type of rear tires used in the Vehicle. */
  readonly rear_tire_type?: string
  /** The diameter of the rear wheels. */
  readonly rear_wheel_diameter?: string
  /** The EPA city fuel economy rating, if available. */
  readonly epa_city?: number | null
  /** The EPA highway fuel economy rating, if available. */
  readonly epa_highway?: number | null
  /** The combined EPA fuel economy rating, if available. */
  readonly epa_combined?: number | null
  /** Description of the Vehicle's engine. */
  readonly engine_description?: string
  /** Brand of the Vehicle's engine. */
  readonly engine_brand?: string
  /** Aspiration type of the engine, if available. */
  readonly engine_aspiration?: string | null
  /** Block type of the engine, if available. */
  readonly engine_block_type?: string | null
  /** Bore size of the engine, if available. */
  readonly engine_bore?: number | null
  /** Camshaft type of the engine, if available. */
  readonly engine_cam_type?: string | null
  /** Compression ratio of the engine, if available. */
  readonly engine_compression?: number | null
  /** Number of engine cylinders, if available. */
  readonly engine_cylinders?: number | null
  /** Engine displacement, if available. */
  readonly engine_displacement?: number | null
  /** Fuel induction method, if available. */
  readonly fuel_induction?: string | null
  /** Fuel quality required for the engine. */
  readonly fuel_quality?: string
  /** Maximum horsepower produced by the engine, if available. */
  readonly max_hp?: number | null
  /** Maximum torque produced by the engine, if available. */
  readonly max_torque?: number | null
  /** Oil capacity of the engine, if available. */
  readonly oil_capacity?: number | null
  /** Redline RPM of the engine. */
  readonly redline_rpm?: string
  /** Stroke length of the engine, if available. */
  readonly engine_stroke?: number | null
  /** Number of engine valves, if available. */
  readonly engine_valves?: number | null
  /** Description of the Vehicle's transmission. */
  readonly transmission_description?: string
  /** Brand of the Vehicle's transmission. */
  readonly transmission_brand?: string
  /** Type of transmission, if available. */
  readonly transmission_type?: string | null
  /** Number of gears in the transmission, if available. */
  readonly transmission_gears?: number | null
  /** Cargo volume of the Vehicle, if available. */
  readonly cargo_volume?: number | null
  /** Interior volume of the Vehicle, if available. */
  readonly interior_volume?: number | null
  /** Passenger volume of the Vehicle. */
  readonly passenger_volume?: string
  /** The date and time when the specs were created. */
  readonly created_at?: string
  /** The date and time when the specs were last updated. */
  readonly updated_at?: string
  /** Type of duty the Vehicle is designed for, if available. */
  readonly duty_type?: string | null
  /** Weight class of the Vehicle, if available. */
  readonly weight_class?: string | null
  /** Bore size of the engine with units, if available. */
  readonly engine_bore_with_units?: string | null
  /** Wheelbase of the Vehicle with units, if available. */
  readonly wheelbase_with_units?: string | null
  /** Manufacturer's Suggested Retail Price (MSRP). */
  readonly msrp?: string | null
}

export interface FleetioCurrentLocationEntryAddressComponents {
  /** The street number in the address. */
  readonly street_number?: string
  /** The street name in the address. */
  readonly street?: string
  /** The city in the address. */
  readonly city?: string
  /** The region, state or province in the address. */
  readonly region?: string
  /** The abbreviated region, state or province code. */
  readonly region_short?: string
  /** The country in the address. */
  readonly country?: string
  /** The abbreviated country code. */
  readonly country_short?: string
  /** The postal code, ZIP, or equivalent in the address. */
  readonly postal_code?: string
}

/** The current location of the associated object. */
export interface FleetioCurrentLocationEntry {
  /** The unique identifier for the current Location Entry. */
  readonly id?: number
  /** The type of object that this Location Entry is associated with. */
  readonly locatable_type?: string
  /** The unique identifier of the object that this Location Entry is associated with. */
  readonly locatable_id?: number
  /** The date and time when this Location Entry was recorded. */
  readonly date?: string
  /** The date and time when this Location Entry was created. */
  readonly created_at?: string
  /** The date and time when this Location Entry was last updated. */
  readonly updated_at?: string
  /** The unique identifier of the associated Contact. */
  readonly contact_id?: number
  /** The address associated with this Location Entry. */
  readonly address?: string
  /** Indicates whether this Location Entry is the current location. */
  readonly is_current?: boolean
  /** The type of item associated with this Location Entry. */
  readonly item_type?: string
  /** The unique identifier of the item associated with this Location Entry. */
  readonly item_id?: number
  /** The geographical location in the format "POINT (longitude latitude)". */
  readonly location?: string
  readonly address_components?: FleetioCurrentLocationEntryAddressComponents
  readonly geolocation?: { readonly latitude?: number; readonly longitude?: number }
}

/** A Part */
export interface FleetioPartMini {
  readonly id?: number
  /** A description of this Part. */
  readonly description?: string | null
  /** The part number from this Part's manufacturer. */
  readonly manufacturer_part_number?: string | null
  /** The id of the `MeasurementUnit` associated with this Part. */
  readonly measurement_unit_id?: number | null
  /** The part number being used for this Part within Fleetio. */
  readonly number?: string
  /** The id of the `PartCategory` associated with this Part. */
  readonly part_category_id?: number | null
  /** The id of the `PartManufacturer` associated with this Part. */
  readonly part_manufacturer_id?: number | null
  /** The Universal Product Code for this Part. */
  readonly upc?: string | null
  /** The average unit cost in cents for this Part. */
  readonly average_unit_cost_cents?: number | null
  /** The unit cost in cents for this Part. */
  readonly unit_cost_cents?: number | null
  /** The date and time at which this Part was archived. */
  readonly archived_at?: string | null
  readonly created_at?: string
  readonly updated_at?: string
}

export interface FleetioInspectionItem {
  /** The ID of the Inspection Item. */
  readonly id?: number
  /** The ID of the Inspection Form version to which this item belongs. */
  readonly inspection_form_version_id?: number
  /** The Fleetio Account ID associated with this Inspection Item. */
  readonly account_id?: number
  /** The type or category of the Inspection Item. */
  readonly type?:
    | "InspectionDateItem"
    | "InspectionDatetimeItem"
    | "InspectionDropdownItem"
    | "InspectionFreeTextItem"
    | "InspectionMeterEntryItem"
    | "InspectionNumericItem"
    | "InspectionPassFailItem"
    | "InspectionPhotoItem"
    | "InspectionSectionItem"
    | "InspectionSignatureItem"
    | "InspectionSingleCheckboxItem"
  /** The label or name of the Inspection Item. */
  readonly label?: string
  /** A brief description of the Inspection Item. */
  readonly short_description?: string | null
  /** Instructions or guidance for completing the Inspection Item. */
  readonly instructions?: string | null
  /** Indicates whether this Inspection Item is required to be completed. */
  readonly required?: boolean
  /** The position or order of the Inspection Item within the form. */
  readonly position?: number
  /** Indicates whether a remark is required for a "Fail" result. */
  readonly require_remark_for_fail?: boolean
  /** The label for a "Pass" result. */
  readonly pass_label?: string | null
  /** The label for a "Fail" result. */
  readonly fail_label?: string | null
  /** Indicates whether to reuse pass/fail labels for this item. */
  readonly reuse_pass_fail_label?: boolean
  /** Indicates whether a Secondary Meter Entry is required, if a secondary meter is in use. */
  readonly require_secondary_meter_if_one_exists?: boolean
  /** The date and time when the Inspection Item was created. */
  readonly created_at?: string
  /** The date and time when the Inspection Item was last updated. */
  readonly updated_at?: string
  /** The version key associated with the Inspection Item. */
  readonly version_key?: string | null
  /** The label for "Not Applicable" option. */
  readonly na_label?: string | null
  /** Indicates whether the "Not Applicable" option is enabled for submission. */
  readonly enable_na_option_for_submission?: boolean
  /** Indicates whether a remark is required for a "Pass" result. */
  readonly require_remark_for_pass?: boolean
  /** An array of options for an `InspectionDropdownItem`. */
  readonly dropdown_options?: readonly string[]
  /** The minimum value allowed for an InspectionNumericItem. */
  readonly numeric_range_min?: number | null
  /** The maximum value allowed for an InspectionNumericItem. */
  readonly numeric_range_max?: number | null
  /** Indicates whether a photo of the meter is required for verification. */
  readonly require_meter_entry_photo_verification?: boolean
}

export interface FleetioVmrsReasonForRepairCode {
  readonly account_id?: number
  readonly alias?: string | null
  readonly code?: string | null
  readonly enabled?: boolean
  readonly id?: number
  readonly name?: string
  readonly repair_type?: string | null
  readonly standard?: boolean
  readonly standard_name?: string | null
  readonly type?: string
  readonly vmrs_standard_reason_for_repair?: Readonly<Record<string, unknown>> | null
}

export interface FleetioVmrsSystemCode {
  readonly account_id?: number | null
  readonly assembly_code?: string | null
  readonly assembly_name?: string | null
  readonly code_type?: "system_group" | "system" | "assembly" | "component"
  readonly component_code?: string | null
  readonly component_name?: string | null
  readonly enabled?: boolean
  readonly id?: number
  readonly permissions?: { readonly destroy?: boolean } | null
  readonly standard?: boolean
  readonly system_code?: string | null
  readonly system_group?: string | null
  readonly system_group_code?: string | null
  readonly system_name?: string | null
  readonly type?: string
  readonly vmrs_standard_system_assembly_component?: Readonly<Record<string, unknown>> | null
}

export interface FleetioWorkOrderVmrsRepairPriorityClass {
  /** The ID of the VMRS Repair Priority Class. */
  readonly id?: number
  /** The code of the VMRS Repair Priority Class. */
  readonly code?: string
  /** The name of the VMRS Repair Priority Class. */
  readonly name?: string
  /** The color of the VMRS Repair Priority Class. */
  readonly color?: string
}

export interface FleetioAttachmentAttributes {
  /** The name to give the file which will be shown in the UI. */
  readonly name?: string
  /** The URL obtained from our storage provider that points to the file. */
  readonly file_url?: string
  /** The MIME type of the file. */
  readonly file_mime_type?: string
  /** The name of the file. */
  readonly file_name?: string
  /** The size of the file in bytes. */
  readonly file_size?: number
}

/** A VMRS Reason for Repair */
export interface FleetioVmrsReasonForRepair {
  readonly id?: number
  /** The code associated with this reason for repair. */
  readonly code?: string
  /** The name of this reason for repair. */
  readonly name?: string
  /** The type of repair this reason for repair is associated with. */
  readonly repair_type?: string
  /** Whether this reason for repair is enabled. */
  readonly enabled?: boolean
}

export interface FleetioVehicleDriver {
  readonly id?: number | null
  /** The first name of the `Contact` (driver) associated with this Vehicle. */
  readonly first_name?: string | null
  /** The last name of the `Contact` (driver) associated with this Vehicle. */
  readonly last_name?: string | null
  /** The full name of the `Contact` (driver) associated with this Vehicle. */
  readonly full_name?: string | null
  /** Whether or not the `Contact` (driver) associated with this Vehicle is an employee. */
  readonly employee?: boolean | null
  /** The employee number of the `Contact` (driver) associated with this Vehicle. */
  readonly employee_number?: string | null
  /** The URL of the default image of the `Contact` (driver) associated with this Vehicle. */
  readonly default_image_url?: string | null
}
