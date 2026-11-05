import type { FleetioComment } from "./comments"
import type {
  FleetioBooleanFilter,
  FleetioEqFilter,
  FleetioLikeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type {
  FleetioAttachmentAttributes,
  FleetioAttachmentPermissions,
  FleetioDocument,
  FleetioEmbeddedPartLocationDetail,
  FleetioImage,
  FleetioPartCategory,
  FleetioPartCrossReferenceMember,
} from "./shared"

export interface FleetioPartTireConfig {
  readonly id?: number
  /** Aspect ratio of tire. */
  readonly aspect_ratio?: number
  /** Rim diameter of tire. */
  readonly rim_diameter?: number
  /** Load index of tire. */
  readonly load_index?: number
  /** Metric type of tire. */
  readonly metric_type?: "EU" | "P" | "HL" | "T" | "LT" | "C" | "ST"
  /** Width of tire. */
  readonly width?: number
  /** Construction type of tire. */
  readonly construction?: "B" | "R" | "D"
  /** Speed rating of tire. */
  readonly speed_rating?:
    | "A1"
    | "A2"
    | "A3"
    | "A4"
    | "A5"
    | "A6"
    | "A7"
    | "A8"
    | "B"
    | "C"
    | "D"
    | "E"
    | "F"
    | "G"
    | "H"
    | "J"
    | "K"
    | "L"
    | "M"
    | "N"
    | "P"
    | "Q"
    | "R"
    | "S"
    | "T"
    | "U"
    | "V"
    | "W"
    | "Y"
  /** Tread depth of tire in /32" when new, as specified by the manufacturer. */
  readonly factory_tread_depth?: number
  /** The legal minimum tread depth, in /32". */
  readonly minimum_tread_depth?: number
  /** The Life Expectancy or “Warranty” of a tire is the expected meter range, usually measured in miles, of a given tire as specified by the manufacturer. */
  readonly life_expectancy?: number
}

/** A Part */
export interface FleetioPart {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** A description of this Part. */
  readonly description: string | null
  /** The part number from this Part's manufacturer. */
  readonly manufacturer_part_number: string | null
  readonly measurement_unit_id: number | null
  /** The part number being used for this Part within Fleetio. */
  readonly number: string
  readonly part_category_id: number | null
  readonly part_manufacturer_id: number | null
  /** The Universal Product Code for this Part. */
  readonly upc: string | null
  /** The total quantity on hand for this Part. */
  readonly total_quantity: number
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  /** Indicates whether or not this Part is an inventory item. */
  readonly inventory_item: boolean
  readonly part_category?: FleetioPartCategory | null
  /** The name of the part category associated with this Part. */
  readonly part_category_name: string | null
  /** The name of the Part's manufacturer. */
  readonly part_manufacturer_name: string | null
  /** The measurement unit used by this Part. */
  readonly measurement_unit_name: string | null
  /** The unit cost for this Part. */
  readonly unit_cost: number | null
  /** The average unit cost for this Part. */
  readonly average_unit_cost?: number | null
  readonly part_locations: readonly FleetioEmbeddedPartLocationDetail[]
  readonly default_image_url: string | null
  readonly default_image_url_medium: string | null
  readonly default_image_url_small: string | null
  readonly default_image_url_large: string | null
  /** The date and time at which this Part was archived. */
  readonly archived_at: string | null
  readonly attachment_permissions: FleetioAttachmentPermissions | null
  /** Indicates whether this Part has any active Inventory Sets. */
  readonly has_active_inventory_sets?: boolean
  readonly tire_config?: FleetioPartTireConfig
  /** Other Parts in this Part's cross-reference group. */
  readonly cross_reference_members?: readonly FleetioPartCrossReferenceMember[]
  /** The cross-reference group this Part belongs to, or `null` when it belongs to none. */
  readonly cross_reference_group_id?: number | null
  /** A list of the comments made on this record. */
  readonly comments: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count: number
  /** A list of the documents attached to this record. */
  readonly documents: readonly FleetioDocument[]
  /** The number of documents attached to this record. */
  readonly documents_count: number
  /** A list of the images attached to this record. */
  readonly images: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count: number
}

export interface FleetioPartSummaryPartManufacturer {
  readonly id?: number
  /** The name of the Part Manufacturer. */
  readonly name?: string
  readonly description?: string | null
  /** The date and time at which this Part Manufacturer was created. */
  readonly created_at?: string | null
  /** The date and time at which this Part Manufacturer was last updated. */
  readonly updated_at?: string | null
  readonly account_id?: number
}

/** A Part */
export interface FleetioPartSummary {
  readonly created_at: string
  /** The number of images associated with this Part. */
  readonly images_count: number
  /** The number of documents associated with this Part. */
  readonly documents_count: number
  /** The number of comments associated with this Part. */
  readonly comments_count: number
  readonly id: number
  /** A description of this Part. */
  readonly description: string | null
  /** The part number from this Part's manufacturer. */
  readonly manufacturer_part_number: string | null
  /** The id of the Measurement Unit associated with this Part. */
  readonly measurement_unit_id: number | null
  /** The part number being used for this Part within Fleetio. */
  readonly number: string
  /** The id of the Part Category associated with this Part. */
  readonly part_category_id: number | null
  /** The id of the Part Manufacturer associated with this Part. */
  readonly part_manufacturer_id: number | null
  /** The Universal Product Code for this Part. */
  readonly upc: string | null
  /** The unit cost in cents for this Part. */
  readonly unit_cost_cents: number | null
  /** The average unit cost in cents for this Part. */
  readonly average_unit_cost_cents: string | null
  readonly default_image_url: string | null
  /** The date and time at which this Part was archived. */
  readonly archived_at: string | null
  readonly attachment_permissions: FleetioAttachmentPermissions | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly part_manufacturer?: FleetioPartSummaryPartManufacturer | null
  readonly part_category?: FleetioPartCategory | null
  /** The cross-reference group this Part belongs to, or `null` when it belongs to none. */
  readonly cross_reference_group_id?: number | null
  readonly updated_at?: string
}

export interface FleetioPartFilter {
  readonly manufacturer_part_number?: FleetioLikeOrEqFilter
  readonly number?: FleetioLikeOrEqFilter
  readonly upc?: FleetioEqFilter
  readonly part_category_id?: FleetioEqFilter
  readonly part_manufacturer_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioPartSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioPartCreateInput {
  readonly description?: string
  /** The part number from this Part's manufacturer. */
  readonly manufacturer_part_number?: string
  readonly measurement_unit_id?: number
  /** The name of the measurement unit. */
  readonly measurement_unit_name?: string
  /** The part number to be used for this Part within Fleetio. */
  readonly number: string
  readonly part_category_id?: number
  /** The name of the part category. */
  readonly part_category_name?: string
  readonly part_manufacturer_id?: number
  /** The name of the part manufacturer. */
  readonly part_manufacturer_name?: string
  /** The cost per unit of this Part, which will be interpreted as dollars, or dollars and cents. */
  readonly unit_cost?: number
  /** The Universal Product Code for this Part. */
  readonly upc?: string
  /** `tire_config_attributes` are available to accounts on Premium plans Parts that have a Part Category where `tire_category` is `true` can have a TireConfg which are tire-specific Part attributes. */
  readonly tire_config_attributes?: FleetioPartTireConfig
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
}

export interface FleetioMeasurementUnit {
  readonly id?: number
  readonly name?: string | null
  readonly description?: string | null
  readonly symbol?: string | null
}

/** A Part */
export interface FleetioPartCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** A description of this Part. */
  readonly description: string | null
  /** The part number from this Part's manufaturer. */
  readonly manufacturer_part_number: string | null
  readonly measurement_unit_id: number | null
  /** A unique number for this Part. */
  readonly number: string
  readonly part_category_id: number | null
  readonly part_manufacturer_id: number | null
  /** The Universal Product Code for this Part. */
  readonly upc: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  /** The unit cost for this Part in cents. */
  readonly unit_cost_cents?: number | null
  /** The average unit cost for this Part in cents. */
  readonly average_unit_cost_cents?: number | null
  /** The number of images attached to this Part. */
  readonly images_count: number
  /** The number of documents attached to this Part. */
  readonly documents_count: number
  /** The number of `Comments` attached to this Part. */
  readonly comments_count: number
  /** The date and time at which this Part was archived. */
  readonly archived_at: string | null
  readonly measurement_unit?: FleetioMeasurementUnit | null
  /** Indicates whether this Part has any active Inventory Sets. */
  readonly has_active_inventory_sets?: boolean
}

export type FleetioPartUpdateInput = Partial<FleetioPartCreateInput>

export interface FleetioPartLocationMetadata {
  /** Whether or not this Part Location has any `Work Orders`. */
  readonly has_work_orders?: boolean
  /** Whether or not this Part Location has any active `Work Orders`. */
  readonly has_active_work_orders?: boolean
  /** Whether or not this Part Location has any `Purchase Orders`. */
  readonly has_purchase_orders?: boolean
  /** Whether or not this Part Location has any active `Purchase Orders`. */
  readonly has_active_purchase_orders?: boolean
  /** Whether or not this Part Location has any `Inventory Sets`. */
  readonly has_inventory_sets?: boolean
  /** Whether or not this Part Location has any active `Inventory Sets`. */
  readonly has_active_inventory_sets?: boolean
}

/** A Part Location */
export interface FleetioPartLocation {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of this Part Location. */
  readonly name: string
  /** A description of this Part Location. */
  readonly description: string | null
  /** The date and time at which this Part Location was archived. */
  readonly archived_at: string | null
  /** If this Part Location has any metadata, it will be shown here. */
  readonly metadata: FleetioPartLocationMetadata
}

export interface FleetioPartLocationFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioPartLocationSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

/** A Part with default image URLs. */
export interface FleetioPartMiniWithDefaultImageUrls {
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
  /** A large URL for the default image attached to this Part. */
  readonly default_image_url?: string | null
  /** A medium URL for the default image attached to this Part. */
  readonly default_image_url_medium?: string | null
  /** A small URL for the default image attached to this Part. */
  readonly default_image_url_small?: string | null
  /** A full-size URL for the default image attached to this Part. */
  readonly default_image_url_large?: string | null
}

/** The details of a Part at a specific Part Location, including associated Part and Part Location objects. */
export interface FleetioPartLocationDetail {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  readonly active: boolean
  readonly aisle?: string | null
  readonly available_quantity?: number | null
  readonly available_quantity_updated_at?: string | null
  readonly average_unit_cost_cents?: number | null
  readonly bin?: string | null
  readonly last_printed_at?: string | null
  readonly max_quantity?: number | null
  readonly part_archived_at?: string | null
  readonly part_id: number
  readonly part_location_archived_at?: string | null
  readonly part_location_id: number
  readonly quantity_allocated_to_work_orders?: number | null
  readonly quantity_on_hand?: number | null
  readonly quantity_on_order?: number | null
  readonly quantity_requested?: number | null
  readonly reorder_point?: number | null
  readonly reorder_point_enabled: boolean
  readonly reorder_point_lead_time_days?: number | null
  readonly reorder_quantity?: number | null
  readonly reorder_quantity_lead_time_days?: number | null
  readonly row?: string | null
  readonly total_inventory_value_cents?: number | null
  readonly track_inventory: boolean
  readonly watchers_count: number
  /** A Part with default image URLs. */
  readonly part: FleetioPartMiniWithDefaultImageUrls
  /** A Part Location */
  readonly part_location: FleetioPartLocation
}

export interface FleetioPartLocationDetailFilter {
  readonly part_id?: FleetioEqFilter
  readonly part_location_id?: FleetioEqFilter
  readonly part_number_or_description?: FleetioLikeFilter
  readonly active?: FleetioBooleanFilter
  readonly track_inventory?: FleetioBooleanFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioPartLocationDetailSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioArchivedPartFilter {
  readonly manufacturer_part_number?: FleetioLikeOrEqFilter
  readonly number?: FleetioLikeOrEqFilter
  readonly upc?: FleetioEqFilter
  readonly part_category_id?: FleetioEqFilter
  readonly part_manufacturer_id?: FleetioEqFilter
}

/** An Inventory Set */
export interface FleetioInventorySet {
  readonly id?: number
  /** The Fleetio ID for the `Part` associated with this Inventory Set. */
  readonly part_id: number
  /** The ID of the `PartLocationDetail` associated with this Inventory Set. */
  readonly part_location_detail_id?: number
  /** The date and time at which this Inventory Set was added. */
  readonly added_at: string
  /** The number of `Parts` available for use in this Inventory Set. */
  readonly available_quantity: string
  /** The number of `Parts` which were originally added to this Inventory Set. */
  readonly original_quantity: string
  /** The cost of each `Part` in this Inventory Set in cents. */
  readonly unit_cost_cents: string
  readonly created_at?: string
  readonly updated_at?: string
}

export interface FleetioPartInventorySetFilter {
  readonly purchase_order_line_item_id?: FleetioEqFilter
  readonly added_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioPartInventorySetSort {
  readonly id?: FleetioSortDirection
  readonly added_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}
