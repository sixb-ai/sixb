import type {
  FleetioEqFilter,
  FleetioIncludeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioCommentsAttributes, FleetioPartMini } from "./shared"

/** An Inventory Journal Entry */
export interface FleetioInventoryJournalEntry {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The ID of the `User` associated with the entry. */
  readonly user_id: number
  /** The ID of the `Part` associated with the entry. */
  readonly part_id: number
  /** The `Part` number (unique) and ID of the `Part` associated with the entry. */
  readonly part: { readonly number?: string; readonly id?: number }
  /** The ID of the details of this `Part` at a specific `Part Location`. */
  readonly part_location_detail_id: number
  /** Information about the associated `Part Location`. */
  readonly part_location: { readonly name?: string; readonly id?: number }
  /** The previous quantity of the `Part` before any adjustments. */
  readonly previous_quantity: string
  /** The current quantity of the `Part` after adjustments. */
  readonly current_quantity: string
  /** The quantity adjustment made to the `Part`'s count. */
  readonly adjustment_quantity: string
  /** Information about the associated `Work Order`, if applicable. */
  readonly work_order: { readonly number?: string; readonly id?: number } | null
  /** The ID of the `Work Order Part Line Item` associated with the entry. */
  readonly work_order_part_line_item_id: number | null
  /** The ID of the Inventory Adjustment Reason associated with the entry. */
  readonly inventory_adjustment_reason_id: number | null
  readonly inventory_adjustment_reason: { readonly name?: string } | null
  /** How many `Comments` this entry has. */
  readonly comments_count: number
  /** The type of adjustment that triggered the entry. */
  readonly adjustment_type:
    | "initial"
    | "manual"
    | "work_order"
    | "purchase_order"
    | "bulk_update"
    | "transfer"
    | "inspection_submission"
    | "inspection_shortfall"
  /** The ID of the `Part Location` that the `Part` was transferred to. */
  readonly transfer_part_location_id: number | null
  /** Information about the associated `Purchase Order`, if applicable. */
  readonly purchase_order: { readonly number?: string; readonly id?: number } | null
  /** The ID of the ``Purchase Order Line Item` associated with the entry. */
  readonly purchase_order_line_item_id: number | null
  /** The ID of the `Work Order` associated with the entry. */
  readonly work_order_id: number | null
  /** The ID of the `Vendor` associated with the entry. */
  readonly vendor_id: number | null
  /** Information about the associated `Vendor`, if applicable. */
  readonly vendor: { readonly name?: string; readonly id?: number } | null
  /** Information about the `User` that created the entry. */
  readonly user: { readonly email?: string }
}

/** An Inventory Journal Entry */
export interface FleetioInventoryJournalEntrySummary {
  readonly id?: number
  readonly account_id: number
  /** The ID of the `User` associated with the entry. */
  readonly user_id: number
  /** The ID of the `Part` associated with the entry. */
  readonly part_id: number
  /** The ID of the details of this `Part` at a specific `Part Location`. */
  readonly part_location_detail_id: number
  /** Information about the associated `Part Location`. */
  readonly part_location: { readonly name?: string; readonly id?: number }
  /** The previous quantity of the `Part` before any adjustments. */
  readonly previous_quantity: string
  /** The current quantity of the `Part` after adjustments. */
  readonly current_quantity: string
  /** The quantity adjustment made to the `Part`'s count. */
  readonly adjustment_quantity: string
  /** The ID of the `Work Order Part Line Item` associated with the entry. */
  readonly work_order_part_line_item_id: number | null
  /** The ID of the Inventory Adjustment Reason associated with the entry. */
  readonly inventory_adjustment_reason_id: number | null
  readonly inventory_adjustment_reason: { readonly name?: string } | null
  /** How many `Comments` this entry has. */
  readonly comments_count: number
  /** The type of adjustment that triggered the entry. */
  readonly adjustment_type:
    | "initial"
    | "manual"
    | "work_order"
    | "purchase_order"
    | "bulk_update"
    | "transfer"
    | "inspection_submission"
    | "inspection_shortfall"
  /** The ID of the `Part Location` that the `Part` was transferred to. */
  readonly transfer_part_location_id: number | null
  /** The ID of the ``Purchase Order Line Item` associated with the entry. */
  readonly purchase_order_line_item_id: number | null
  /** The ID of the `Work Order` associated with the entry. */
  readonly work_order_id: number | null
  /** The ID of the `Vendor` associated with the entry. */
  readonly vendor_id: number | null
  /** Information about the `User` that created the entry. */
  readonly user: { readonly email?: string }
  /** A Part */
  readonly part: FleetioPartMini
}

export interface FleetioInventoryJournalEntryFilter {
  readonly adjustment_type?: FleetioIncludeFilter
  readonly user_id?: FleetioEqFilter
  readonly part_id?: FleetioEqFilter
  readonly part_location_detail_id?: FleetioEqFilter
  readonly transfer_part_location_id?: FleetioEqFilter
  readonly inventory_adjustment_reason_id?: FleetioEqFilter
  readonly purchase_order_line_item_id?: FleetioEqFilter
  readonly work_order_id?: FleetioEqFilter
  readonly vendor_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioInventoryJournalEntrySort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioInventoryAdjustmentByQuantityChange {
  /** The quantity adjustment to be made to the `Part`'s count. */
  readonly adjustment_quantity: number
  /** The ID of the Inventory Adjustment Reason associated with the entry. */
  readonly inventory_adjustment_reason_id: number
  /** The current quantity of the `Part` after adjustments. */
  readonly current_quantity?: number
  /** The ID of the `Part` associated with the entry. */
  readonly part_id: number
  /** This ID refers to the details of the `Part` at a specific `Part Location`. */
  readonly part_location_detail_id: number
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
}

export interface FleetioInventoryAdjustmentByCurrentQuantity {
  /** The quantity adjustment to be made to the `Part`'s count. */
  readonly adjustment_quantity?: number
  /** The ID of the Inventory Adjustment Reason associated with the entry. */
  readonly inventory_adjustment_reason_id: number
  /** The current quantity of the `Part` after adjustments. */
  readonly current_quantity: number
  /** The ID of the `Part` associated with the entry. */
  readonly part_id: number
  /** This ID refers to the details of the `Part` at a specific `Part Location`. */
  readonly part_location_detail_id: number
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
}

/** Adjust by a quantity change, or state the quantity now on hand. */
export type FleetioInventoryJournalEntryCreateInput =
  | FleetioInventoryAdjustmentByQuantityChange
  | FleetioInventoryAdjustmentByCurrentQuantity

/** An InventoryAdjustmentReason */
export interface FleetioInventoryJournalEntryCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The ID of the `User` associated with the entry. */
  readonly user_id: number
  /** The ID of the `Part` associated with the entry. */
  readonly part_id: number
  /** The ID of the details of this `Part` at a specific `Part Location`. */
  readonly part_location_detail_id: number
  /** The previous quantity of the `Part` before any adjustments. */
  readonly previous_quantity: string
  /** The current quantity of the `Part` after adjustments. */
  readonly current_quantity: string
  /** The quantity adjustment made to the `Part`'s count. */
  readonly adjustment_quantity: string
  /** The ID of the `Work Order Part Line Item` associated with the entry. */
  readonly work_order_part_line_item_id: number | null
  /** The ID of the Inventory Adjustment Reason associated with the entry. */
  readonly inventory_adjustment_reason_id: number | null
  /** How many `Comments` this entry has. */
  readonly comments_count: number
  /** The type of adjustment that triggered the entry. */
  readonly adjustment_type:
    | "initial"
    | "manual"
    | "work_order"
    | "purchase_order"
    | "bulk_update"
    | "transfer"
  /** The ID of the `Part Location` that the `Part` was transferred to. */
  readonly transfer_part_location_id: number | null
  /** The ID of the `Purchase Order Line Item` associated with the entry. */
  readonly purchase_order_line_item_id: number | null
  /** The ID of the `Work Order` associated with the entry. */
  readonly work_order_id: number | null
  /** The unit cost in cents of the `Part` associated with the entry. */
  readonly unit_cost_cents?: string | null
  /** The total inventory value in cents of the `Part` associated with the entry. */
  readonly total_inventory_value_cents?: string | null
  /** The ID of the `Vendor` associated with the entry. */
  readonly vendor_id: number | null
  /** Additional metadata about the entry. */
  readonly metadata?: {
    readonly id?: number
    readonly number?: string
    readonly type?: "PurchaseOrder" | "WorkOrder"
  } | null
}

/** An Inventory Adjustment Reason */
export interface FleetioInventoryAdjustmentReason {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  /** The name of the Inventory Adjustment Reason. */
  readonly name?: string
  /** A short description of the Inventory Adjustment Reason. */
  readonly description?: string | null
  /** The number of Inventory Journal Entries using this Inventory Adjustment Reason. */
  readonly inventory_journal_entries_count?: number
}

export interface FleetioInventoryAdjustmentReasonFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioInventoryAdjustmentReasonSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}
