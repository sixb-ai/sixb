import type {
  FleetioEqFilter,
  FleetioIncludeFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type {
  FleetioDiscountType,
  FleetioDocument,
  FleetioTaxType,
  FleetioVendorMini,
} from "./shared"

/** See the Purchase Order Lifecycle Guide for more information about Purchase Order states and how to transition between them. */
export type FleetioPurchaseOrderState =
  | "draft"
  | "submitted_for_approval"
  | "rejected"
  | "approved"
  | "purchased"
  | "received_partial"
  | "received_full"
  | "closed"
  | null

/** A Purchase Order Line Item */
export interface FleetioPurchaseOrderLineItem {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The Fleetio ID of the Part being purchased. */
  readonly part_id: number
  /** The quantity of this `Part` to be purchased. */
  readonly quantity: string | null
  /** The quantity of this `Part` which was received. */
  readonly total_quantity_received: string | null
  /** The number for the `Part` being purchased. */
  readonly part_number?: string | null
  /** The cost of this `Part` (per unit). */
  readonly unit_cost: number | null
  /** The pre-tax subtotal amount. */
  readonly subtotal?: number | null
}

/** A Purchase Order */
export interface FleetioPurchaseOrder {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** Must be unique within the scope of your Account. */
  readonly number: number
  /** Open text field for Purchase Order description. */
  readonly description: string | null
  /** A list of tags associated with this record. */
  readonly label_list: readonly string[]
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  /** See the Purchase Order Lifecycle Guide for more information about Purchase Order states and how to transition between them. */
  readonly state: FleetioPurchaseOrderState | null
  /** The name of the Contact associated with the User who created this Purchase Order. */
  readonly created_by?: string | null
  /** The full name of the Contact that rejected the Purchase Order, if applicable. */
  readonly rejected_by?: string | null
  /** The date and time at which this Purchase Order was submitted for approval. */
  readonly submitted_for_approval_at: string | null
  /** The name of the Contact associated with the `User` who submitted this Purchase Order for approval. */
  readonly submitted_for_approval_by?: string | null
  /** The date and time at which this Purchase Order was rejected. */
  readonly rejected_at: string | null
  /** The date and time at which this Purchase Order was approved. */
  readonly approved_at: string | null
  /** The name of the Contact associated with the User who approved this Purchase Order. */
  readonly approved_by?: string | null
  /** The date and time at which this Purchase Order was purchased. */
  readonly purchased_at: string | null
  /** The name of the Contact associated with the User who purchased this Purchase Order. */
  readonly purchased_by?: string | null
  /** The date and time at which this Purchase Order was partially received. */
  readonly received_partial_at: string | null
  /** The name of the Contact associated with the User who received this Purchase Order. */
  readonly received_partial_by?: string | null
  /** The date and time at which this Purchase Order was fully received. */
  readonly received_full_at: string | null
  /** The name of the Contact associated with the User who received this Purchase Order. */
  readonly received_full_by?: string | null
  /** The date and time at which this Purchase Order was closed. */
  readonly closed_at: string | null
  /** The name of the Contact associated with the User who closed this Purchase Order. */
  readonly closed_by?: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  /** The ID of the `Part Location` associated with this Purchase Order. */
  readonly part_location_id: number | null
  /** The ID of the Vendor associated with this Purchase Order. */
  readonly vendor_id: number | null
  /** The name of the `Part Location` associated with this Purchase Order. */
  readonly part_location_name?: string | null
  /** The name of the `Vendor` associated with this Purchase Order. */
  readonly vendor_name?: string | null
  readonly purchase_order_line_items: readonly FleetioPurchaseOrderLineItem[]
  /** The number of documents attached to this record. */
  readonly documents_count: number
  /** The number of `Comments` on this Purchase Order. */
  readonly comments_count: number | null
  /** The shipping cost of this purchase. */
  readonly shipping?: number | null
  /** The discount amount applied to this purchase. */
  readonly discount?: number | null
  /** The discount type applied to this purchase. */
  readonly discount_type?: string | null
  /** The discount percentage applied to this purchase. */
  readonly discount_percentage?: number | null
  /** The primary tax amount on this purchase */
  readonly tax_1?: number | null
  /** The primary tax type on this purchase */
  readonly tax_1_type?: string | null
  /** The secondary tax amount on this purchase. */
  readonly tax_2?: number | null
  /** The subtotal of this purchase. */
  readonly subtotal?: number | null
  /** The total amount of this Purchase Order, including all line items, discounts, taxes, and shipping. */
  readonly total_amount?: number | null
  /** A list of the documents attached to this record. */
  readonly documents?: readonly FleetioDocument[]
}

/** A Purchase Order */
export interface FleetioPurchaseOrderSummary {
  readonly id: number
  /** The Purchase Order Number. */
  readonly number: number
  /** Open text field for Purchase Order description. */
  readonly description: string | null
  /** See the Purchase Order Lifecycle Guide for more information about Purchase Order states and how to transition between them. */
  readonly state: FleetioPurchaseOrderState | null
  readonly documents_count: number
  readonly comments_count: number
  readonly watchers_count: number
  /** The discount type applied to this purchase. */
  readonly discount_type: string | null
  /** The primary tax type on this purchase */
  readonly tax_1_type: string | null
  /** The secondary tax type on this purchase */
  readonly tax_2_type: string | null
  /** The date and time at which this Purchase Order was submitted for approval. */
  readonly submitted_for_approval_at: string | null
  /** The date and time at which this Purchase Order was rejected. */
  readonly rejected_at: string | null
  /** The date and time at which this Purchase Order was approved. */
  readonly approved_at: string | null
  /** The date and time at which this Purchase Order was purchased. */
  readonly purchased_at: string | null
  /** The date and time at which this Purchase Order was partially received. */
  readonly received_partial_at: string | null
  /** The date and time at which this Purchase Order was fully received. */
  readonly received_full_at: string | null
  /** The date and time at which this Purchase Order was closed. */
  readonly closed_at: string | null
  /** The date and time at which this Purchase Order was created. */
  readonly created_at: string | null
  /** The date and time at which this Purchase Order was last updated. */
  readonly updated_at: string | null
  /** The amount fo the discount on this Purchase Order in cents. */
  readonly discount_cents: number | null
  /** The amount of the primary tax on this Purchase Order in cents. */
  readonly tax_1_cents: number | null
  /** The percentage for the primary tax. */
  readonly tax_1_percentage: string | null
  /** The amount of the secondary tax on this Purchase Order in cents. */
  readonly tax_2_cents: number | null
  /** The percentage for the secondary tax. */
  readonly tax_2_percentage: string | null
  /** The subtotal for this Purchase Order in cents. */
  readonly subtotal_cents: number | null
  /** The shipping amount for this Purchase Order in cents. */
  readonly shipping_cents: number | null
  /** The total amount for this Purchase Order in cents. */
  readonly total_amount_cents: number | null
  /** The ID of the `Vendor` for this Purchase Order. */
  readonly vendor_id: number | null
  /** The ID of the `User` who has approved this Purchase Order. */
  readonly approved_by_id: number | null
  /** The ID of the `User` who created this Purchase Order. */
  readonly created_by_id: number | null
  /** The ID of the `User` who has closed this Purchase Order. */
  readonly closed_by_id: number | null
  /** The ID of the `User` who has purchased this Purchase Order. */
  readonly purchased_by_id: number | null
  /** The ID of the `User` who has rejected this Purchase Order. */
  readonly rejected_by_id: number | null
  /** The ID of the `User` who has partially received this Purchase Order. */
  readonly received_partial_by_id: number | null
  /** The ID of the `User` who has received this Purchase Order in full. */
  readonly received_full_by_id: number | null
  /** The ID of the `User` who has submitted this Purchase Order for approval. */
  readonly submitted_for_approval_by_id: number | null
  /** The ID of the `PurchaseOrderStatus` associated with this Purchase Order. */
  readonly purchase_order_status_id: number | null
  /** The ID of the `PartLocation` associated with this Purchase Order. */
  readonly part_location_id: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  /** A Vendor */
  readonly vendor: FleetioVendorMini | null
}

export interface FleetioPurchaseOrderFilter {
  readonly number?: FleetioEqFilter
  readonly part_location_id?: FleetioEqFilter
  readonly rejected_by_id?: FleetioEqFilter
  readonly submitted_for_approval_by_id?: FleetioEqFilter
  readonly purchased_by_id?: FleetioEqFilter
  readonly created_by_id?: FleetioEqFilter
  readonly approved_by_id?: FleetioEqFilter
  readonly vendor_id?: FleetioEqFilter
  readonly state?: FleetioIncludeFilter
  readonly labels?: FleetioIncludeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioPurchaseOrderSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioPurchaseOrderCreateInput {
  readonly description?: string | null
  /** A comma separated list of tags associated with this record. */
  readonly label_list?: string
  readonly vendor_id?: number
  /** The Fleetio ID of the Part Location for the Part being purchased. */
  readonly part_location_id?: number
  /** Must be unique within the scope of your Account. */
  readonly number: number
  /** The type of discount applied to this record. */
  readonly discount_type?: FleetioDiscountType | null
  /** The discount percentage. */
  readonly discount_percentage?: number
  /** The actual value of the discount */
  readonly discount?: number
  /** The cost of shipping */
  readonly shipping?: number
  /** The primary tax percentage amount. */
  readonly tax_1_percentage?: number
  /** The primary tax amount. */
  readonly tax_1?: number
  /** The type of tax to apply to this record. */
  readonly tax_1_type?: FleetioTaxType | null
  /** The secondary tax percentage amount. */
  readonly tax_2_percentage?: number
  /** The secondary tax amount. */
  readonly tax_2?: number
  /** The type of tax to apply to this record. */
  readonly tax_2_type?: FleetioTaxType | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly purchase_order_line_items_attributes?: readonly {
    readonly part_id?: number
    readonly quantity?: number
    readonly unit_cost?: number
  }[]
}

/** A Purchase Order */
export interface FleetioPurchaseOrderCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The type of discount applied to this record. */
  readonly discount_type: FleetioDiscountType | null
  /** The discount percentage. */
  readonly discount_percentage: number | null
  /** The discount amount in cents. */
  readonly discount_cents?: number | null
  /** The type of tax to apply to this record. */
  readonly tax_1_type: FleetioTaxType | null
  /** The primary tax percentage amount. */
  readonly tax_1_percentage: number | null
  /** The primary tax amount in cents. */
  readonly tax_1_cents?: number | null
  /** The type of tax to apply to this record. */
  readonly tax_2_type: FleetioTaxType | null
  /** The secondary tax percentage amount. */
  readonly tax_2_percentage: number | null
  /** The secondary tax amount in cents. */
  readonly tax_2_cents?: number | null
  /** The shipping amount in cents. */
  readonly shipping_cents?: number | null
  readonly account_id: number
  /** Must be unique within the scope of your Account. */
  readonly number: number
  /** Open text field for Purchase Order description. */
  readonly description: string | null
  /** A list of tags associated with this record. */
  readonly label_list: readonly string[]
  /** The date and time at which this Purchase Order was submitted for approval. */
  readonly submitted_for_approval_at: string | null
  /** The date and time at which this Purchase Order was rejected. */
  readonly rejected_at: string | null
  /** The date and time at which this Purchase Order was approved. */
  readonly approved_at: string | null
  /** The date and time at which this Purchase Order was purchased. */
  readonly purchased_at: string | null
  /** The date and time at which this Purchase Order was partially received. */
  readonly received_partial_at: string | null
  /** The date and time at which this Purchase Order was fully received. */
  readonly received_full_at: string | null
  /** The date and time at which this Purchase Order was closed. */
  readonly closed_at: string | null
  /** See the Purchase Order Lifecycle Guide for more information about Purchase Order states and how to transition between them. */
  readonly state: FleetioPurchaseOrderState | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  /** The ID of the `Part Location` associated with this Purchase Order. */
  readonly part_location_id: number | null
  /** The ID of the Vendor associated with this Purchase Order. */
  readonly vendor_id: number | null
  readonly purchase_order_status_id?: number | null
  /** The ID of the Vendor associated with the User who created this Purchase Order. */
  readonly created_by_id?: number | null
  /** The ID of the Vendor associated with the User who closed this Purchase Order. */
  readonly rejected_by_id?: number | null
  /** The ID of the Vendor associated with the User who submitted this Purchase Order for approval. */
  readonly submitted_for_approval_by_id?: number | null
  /** The ID of the Vendor associated with the User who approved this Purchase Order. */
  readonly approved_by_id?: number | null
  /** The ID of the Vendor associated with the User who purchased this Purchase Order. */
  readonly purchased_by_id?: number | null
  /** The ID of the Vendor associated with the User who partially received this Purchase Order. */
  readonly received_partial_by_id?: number | null
  /** The ID of the Vendor associated with the User who fully received this Purchase Order. */
  readonly received_full_by_id?: number | null
  /** The ID of the Vendor associated with the User who closed this Purchase Order. */
  readonly closed_by_id?: number | null
  /** The number of documents attached to this Purchase Order. */
  readonly documents_count: number | null
  /** The number of `Comments` on this Purchase Order. */
  readonly comments_count: number | null
  /** The subtotal amount in cents. */
  readonly subtotal_cents?: number | null
  /** The total amount in cents. */
  readonly total_amount_cents?: number | null
  /** The count of watchers associated with the record. */
  readonly watchers_count?: number
  /** Options related to watching the record. */
  readonly watchable_options?: Readonly<Record<string, unknown>>
  /** Indicates if a bulk watch record is created. */
  readonly bulk_watch_record?: boolean
  /** Indicates if automatic watchers callbacks are skipped. */
  readonly skip_automatic_watchers_callbacks?: boolean
}

export type FleetioPurchaseOrderUpdateInput = Partial<FleetioPurchaseOrderCreateInput>

export interface FleetioPurchaseOrderLineItemSort {
  readonly id?: FleetioSortDirection
}

export interface FleetioPurchaseOrderLineItemCreateInput {
  /** The Fleetio ID of the Part being purchased. */
  readonly part_id: number
  /** How many of this `Part` to be purchased. */
  readonly quantity: number
  /** The cost of this `Part` (per unit). */
  readonly unit_cost: number
}

/** A Purchase Order Line Item */
export interface FleetioPurchaseOrderLineItemCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  readonly purchase_order_id?: number
  /** The Fleetio ID of the Part being purchased. */
  readonly part_id?: number
  /** The quantity of this `Part` to be purchased. */
  readonly quantity?: string | null
  /** The quantity of this `Part` which was received. */
  readonly total_quantity_received?: string | null
  /** The cost of this `Part` (per unit). */
  readonly unit_cost?: string | null
  /** The pre-tax subtotal amount. */
  readonly subtotal_cents?: number | null
}

export type FleetioPurchaseOrderLineItemUpdateInput =
  Partial<FleetioPurchaseOrderLineItemCreateInput>
