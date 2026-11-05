import type { FleetioComment } from "./comments"
import type {
  FleetioEqFilter,
  FleetioIncludeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioPart } from "./parts"
import type {
  FleetioAttachmentAttributes,
  FleetioAttachmentPermissions,
  FleetioCommentsAttributes,
  FleetioContactMini,
  FleetioDiscountType,
  FleetioDocument,
  FleetioEmbeddedContact,
  FleetioImage,
  FleetioLaborMarkupType,
  FleetioPartMarkupType,
  FleetioTaxType,
  FleetioVehicleMeterEntry,
  FleetioVehicleMini,
  FleetioVendorMini,
  FleetioVmrsReasonForRepairCode,
  FleetioVmrsSystemCode,
  FleetioWorkOrderVmrsRepairPriorityClass,
} from "./shared"

export interface FleetioLaborTimeEntryData {
  readonly clock_in_latitude?: number
  readonly clock_in_longitude?: number
  readonly clock_out_latitude?: number
  readonly clock_out_longitude?: number
}

/** A Labor Time Entry */
export interface FleetioLaborTimeEntry {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  readonly contact_id?: number
  readonly duration_in_seconds?: number
  readonly ended_at?: string | null
  readonly laborable_id?: number
  readonly laborable_type?: "WorkOrderSubLineItem"
  readonly started_at?: string
  readonly data?: FleetioLaborTimeEntryData
  /** Indicates whether this Labor Time Entry is active. */
  readonly active?: boolean
}

/** A Work Order Sub Line Item */
export interface FleetioWorkOrderSubLineItemForContact {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The description of the sub line item. */
  readonly description?: string | null
  readonly item_id?: number
  readonly item_type?: "Contact"
  readonly work_order_line_item_id?: number | null
  /** The quantity of this sub line item. */
  readonly quantity?: number
  readonly part_location_detail_id?: number | null
  /** The position of this sub line item in a list of sub line items. */
  readonly position?: number | null
  /** The name of this sub line item. */
  readonly item_name?: string
  /** The unit cost of this sub line item. */
  readonly unit_cost?: number
  /** A Contact */
  readonly contact?: FleetioEmbeddedContact | null
  readonly labor_time_entries?: readonly FleetioLaborTimeEntry[]
}

/** A Work Order Sub Line Item */
export interface FleetioWorkOrderSubLineItemForPart {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The description of this sub line item. */
  readonly description?: string | null
  /** The ID of the `Part` associated with this sub line item. */
  readonly item_id?: number
  readonly item_type?: "Part"
  readonly work_order_line_item_id?: number | null
  /** The quantity of this sub line item. */
  readonly quantity?: number
  readonly part_location_detail_id?: number | null
  /** The position of this sub line item in a list of sub line items. */
  readonly position?: number | null
  /** The name of this sub line item. */
  readonly item_name?: string
  /** The unit cost of this sub line item. */
  readonly unit_cost?: number | null
  /** A Part */
  readonly part?: FleetioPart
}

export interface FleetioSubmittedInspectionFormContact {
  readonly id?: number
  readonly name?: string
  readonly email?: string | null
  readonly employee?: boolean
  readonly employee_number?: string | null
  readonly group_id?: number | null
  readonly default_image_url?: string | null
}

/** A Work Order Sub Line Item */
export interface FleetioWorkOrderSubLineItemForInspectionForm {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The description of this sub line item. */
  readonly description?: string | null
  /** The ID of the `Inspection Form` associated with this sub line item. */
  readonly item_id?: number
  readonly item_type?: "InspectionForm"
  readonly work_order_line_item_id?: number | null
  /** The quantity of this sub line item. */
  readonly quantity?: number
  readonly part_location_detail_id?: number | null
  /** The position of this sub line item in a list of sub line items. */
  readonly position?: number | null
  /** The name of this sub line item. */
  readonly item_name?: string
  /** The unit cost of this sub line item. */
  readonly unit_cost?: number | null
  /** The `Inspection Form` associated with this sub line item. */
  readonly inspection_form?: {
    readonly id?: number
    readonly title?: string
    readonly color?: string | null
  }
  /** The submitted `Inspection Form`, when one has been submitted for this line item. */
  readonly submitted_inspection_form?: {
    readonly id?: number
    readonly contact?: FleetioSubmittedInspectionFormContact
  } | null
}

export type FleetioWorkOrderSubLineItem =
  | FleetioWorkOrderSubLineItemForContact
  | FleetioWorkOrderSubLineItemForPart
  | FleetioWorkOrderSubLineItemForInspectionForm

/** A Work Order Line Item */
export interface FleetioWorkOrderLineItem {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** A description of this Work Order Line Item. */
  readonly description: string | null
  /** The title of this Work Order Line Item. */
  readonly title?: string
  /** The ID of the item associated with this Work Order Line Item. */
  readonly item_id: number
  /** The type of item associated with this Work Order Line Item. */
  readonly item_type: "Issue" | "ServiceTask"
  readonly work_order_line_item_id: number | null
  /** The name of the item associated with this Work Order Line Item. */
  readonly item_name: string
  /** The position of this Work Order Line Item in a list of Work Order Line Items. */
  readonly position: number | null
  /** Any `Issues` associated with this Work Order Line Item. */
  readonly issues: readonly { readonly id?: number; readonly name?: string }[]
  readonly vmrs_reason_for_repair: FleetioVmrsReasonForRepairCode | null
  readonly vmrs_system_group: FleetioVmrsSystemCode | null
  readonly vmrs_system: FleetioVmrsSystemCode | null
  readonly vmrs_assembly: FleetioVmrsSystemCode | null
  readonly vmrs_component: FleetioVmrsSystemCode | null
  readonly work_order_sub_line_items: readonly FleetioWorkOrderSubLineItem[]
  /** The pre-tax subtotal amount. */
  readonly subtotal?: number | null
  /** The pre-tax subtotal amount in cents. */
  readonly subtotal_cents?: number | null
  /** The cost of labor units worked. */
  readonly labor_cost?: number | null
  /** The cost of parts. */
  readonly parts_cost?: number | null
  /** The parts cost amount in cents. */
  readonly parts_cost_cents?: number | null
  /** The cost of labor units worked, in cents. */
  readonly labor_cost_cents?: number | null
  readonly completed_at?: string | null
  readonly complaint?: string | null
  readonly cause?: string | null
  readonly correction?: string | null
}

/** A Work Order */
export interface FleetioWorkOrder {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The unique number of this Work Order. */
  readonly number: string
  /** The date and time at which the Work Order was completed. */
  readonly completed_at: string | null
  /** A description of this Work Order. */
  readonly description: string | null
  /** Indicates whether or not the ending meter is the same as the starting meter. */
  readonly ending_meter_same_as_start: boolean
  /** The number of seconds elapsed between beginning this Work Order and completing it. */
  readonly duration_in_seconds: number | null
  /** The number of the `Invoice` associated with this Work Order. */
  readonly invoice_number: string | null
  /** The id of the `User` who created this Work Order. */
  readonly created_by_id: number
  /** Indicates whether this Work Order is currently active or has already been completed. */
  readonly state: "active" | "completed"
  /** The date and time at which the Work Order was issued. */
  readonly issued_at: string
  readonly issued_by_id: number | null
  /** The name of the `Contact` associated with the `User` who issued this Work Order. */
  readonly issued_by_name: string | null
  readonly contact_id: number | null
  /** The name of the `Contact` currently assigned to this Work Order. */
  readonly contact_name: string | null
  /** The number of any `Purchase Order` associated with this Work Order. */
  readonly purchase_order_number: string | null
  /** The date and time at which the Work Order was started. */
  readonly started_at: string | null
  /** The date and time at which the Work Order is expected to be completed. */
  readonly expected_completed_at?: string | null
  /** The URL of the image associated with the `Contact` currently assigned to this Work Order. */
  readonly contact_image_url?: string | null
  readonly work_order_sub_line_items: readonly FleetioWorkOrderSubLineItem[]
  /** The date and time at which the Work Order was scheduled. */
  readonly scheduled_at: string | null
  readonly vehicle_id: number
  /** The name of the `Vehicle` associated with this Work Order. */
  readonly vehicle_name: string
  readonly vendor_id: number | null
  /** The name of the `Vendor` associated with this Work Order. */
  readonly vendor_name: string | null
  readonly work_order_status_id: number
  /** The name of the `Work Order Status` associated with this Work Order. */
  readonly work_order_status_name: string
  /** The color of the `Work Order Status` seen in the UI. */
  readonly work_order_status_color: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  readonly work_order_line_items: readonly FleetioWorkOrderLineItem[]
  readonly labor_time_entries: readonly FleetioLaborTimeEntry[]
  /** A Meter Entry */
  readonly meter_entry?: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly starting_meter_entry?: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly ending_meter_entry?: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly secondary_meter_entry?: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly starting_secondary_meter_entry?: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly ending_secondary_meter_entry?: FleetioVehicleMeterEntry | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** The VMRS Repair Priority Class associated with this Work Order. */
  readonly vmrs_repair_priority_class: FleetioWorkOrderVmrsRepairPriorityClass | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  /** Any `Issues` associated with this Work Order. */
  readonly issues: readonly { readonly id?: number; readonly name?: string }[]
  /** The number of `Users` watching this Work Order. */
  readonly watchers_count?: number
  /** Indicates whether the current `User` is watching this Work Order. */
  readonly is_watched?: boolean
  /** The type of discount applied to this record. */
  readonly discount_type: FleetioDiscountType | null
  /** The discount percentage. */
  readonly discount_percentage: number | null
  /** The discount amount. */
  readonly discount: number | null
  /** The total cost of parts for this record. */
  readonly parts_subtotal: number | null
  /** The total cost of labor for this record. */
  readonly labor_subtotal: number | null
  /** The pre-tax subtotal amount. */
  readonly subtotal: number | null
  /** The type of tax to apply to this record. */
  readonly tax_1_type: FleetioTaxType | null
  /** The primary tax percentage amount. */
  readonly tax_1_percentage: number | null
  /** The type of tax to apply to this record. */
  readonly tax_2_type: FleetioTaxType | null
  /** The secondary tax percentage amount. */
  readonly tax_2_percentage: number | null
  /** The primary tax amount. */
  readonly tax_1: number | null
  /** The secondary tax amount. */
  readonly tax_2: number | null
  /** The type of parts markup applied to the record Note that this is a readonly value that will default to `percentage` for non-premium plans */
  readonly parts_markup_type?: FleetioPartMarkupType
  /** The parts markup amount. */
  readonly parts_markup?: number
  /** The parts markup percentage amount. */
  readonly parts_markup_percentage?: number
  /** The type of labor markup applied to the record Note that this is a readonly value that will default to `percentage` for non-premium plans */
  readonly labor_markup_type?: FleetioLaborMarkupType
  /** The labor markup amount. */
  readonly labor_markup?: number
  /** The labor markup percentage amount. */
  readonly labor_markup_percentage?: number
  /** The total amount. */
  readonly total_amount: number | null
  /** The sum, in seconds, of the duration of all labor line items of a `completed` Work Order. */
  readonly labor_time_in_seconds?: number | null
  /** A list of the comments made on this record. */
  readonly comments?: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count?: number
  /** A list of the images attached to this record. */
  readonly images?: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count?: number
  /** A list of the documents attached to this record. */
  readonly documents?: readonly FleetioDocument[]
  /** The number of documents attached to this record. */
  readonly documents_count?: number
  readonly warranty_credits_type?: string | null
  readonly warranty_credits_percentage?: number | null
  readonly warranty_credits?: number | null
  readonly selected_part_warranty_opportunities_count?: number
}

/** A Work Order */
export interface FleetioWorkOrderSummary {
  readonly vendor_id: number | null
  readonly id: number
  /** The unique number of this Work Order. */
  readonly number: string
  /** The date and time at which the Work Order was completed. */
  readonly completed_at: string | null
  /** A description of this Work Order. */
  readonly description: string | null
  /** Indicates whether or not the ending meter is the same as the starting meter. */
  readonly ending_meter_same_as_start: boolean
  /** The number of seconds elapsed between beginning this Work Order and completing it. */
  readonly duration_in_seconds: number | null
  /** The number of the `Invoice` associated with this Work Order. */
  readonly invoice_number: string | null
  /** The id of the `User` who created this Work Order. */
  readonly created_by_id: number
  /** Indicates whether this Work Order is currently active or has already been completed. */
  readonly state: "active" | "completed"
  /** The date and time at which the Work Order was issued. */
  readonly issued_at: string
  /** The id of the issuer of this Work Order. */
  readonly issued_by_id: number | null
  /** The id of the `Contact` assigned to this Work Order. */
  readonly contact_id: number | null
  /** The purchase order number for this Work Order. */
  readonly purchase_order_number: string | null
  /** The date and time at which the Work Order was scheduled. */
  readonly scheduled_at: string | null
  /** The date and time at which the Work Order was started. */
  readonly started_at: string | null
  /** The date and time at which the Work Order is expected to be completed. */
  readonly expected_completed_at: string | null
  /** The id of the `Vehicle` associated with this Work Order. */
  readonly vehicle_id: number
  /** The id of the `WorkOrderStatus` for this Work Order. */
  readonly work_order_status_id: number
  /** The color of the `Work Order Status` for this Work Order. */
  readonly work_order_status_color?: string | null
  /** The name of the `Work Order Status` for this Work Order. */
  readonly work_order_status_name: string
  /** The count of associated documents. */
  readonly documents_count: number
  /** The count of the associated images. */
  readonly images_count: number
  /** The count of associated comments. */
  readonly comments_count: number
  /** The date and time at which the Work Order was created. */
  readonly created_at: string
  /** The date and time at which the Work Order was last updated. */
  readonly updated_at: string
  /** The sum, in seconds, of the duration of all labor line items of a `completed` Work Order. */
  readonly labor_time_in_seconds?: number | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A Contact */
  readonly contact: FleetioContactMini | null
  /** A Vehicle */
  readonly vehicle: FleetioVehicleMini
  /** A Vendor */
  readonly vendor: FleetioVendorMini | null
  readonly starting_meter_entry?: FleetioVehicleMeterEntry | null
  readonly ending_meter_entry?: FleetioVehicleMeterEntry | null
  readonly vmrs_repair_priority_class?: FleetioWorkOrderVmrsRepairPriorityClass | null
  readonly labels?: readonly { readonly id?: number; readonly name?: string }[]
  readonly issues?: readonly { readonly id?: number; readonly name?: string }[]
}

export interface FleetioWorkOrderFilter {
  readonly contact_id?: FleetioEqFilter
  readonly created_by_id?: FleetioEqFilter
  readonly issued_by_id?: FleetioEqFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly vendor_id?: FleetioEqFilter
  readonly vmrs_repair_priority_class_id?: FleetioEqFilter
  readonly purchase_order_number?: FleetioLikeOrEqFilter
  readonly invoice_number?: FleetioLikeOrEqFilter
  readonly number?: FleetioEqFilter
  readonly labels?: FleetioIncludeFilter
  readonly work_order_status_name?: FleetioIncludeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioWorkOrderSort {
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioWorkOrderSubLineItemsAttributes {
  /** The ID of this Work Order Sub Line Item. */
  readonly id?: number
  readonly type?: "WorkOrderPartLineItem" | "WorkOrderLaborLineItem"
  /** The ID of the `Part` or `Contact` associated with this Work Order Line Item. */
  readonly item_id?: number
  readonly item_type?: "Part" | "Contact"
  /** The quantity of the `Part` or `Contact` associated with this Work Order Line Item. */
  readonly quantity?: number
  /** This ID refers to the details of the `Part` at a specific `Part Location`. */
  readonly part_location_detail_id?: number
  /** The position of this Work Order Line Item in a list of line items. */
  readonly position?: number
  /** The description of this Work Order Line Item. */
  readonly description?: string
  /** The ID of the `Inventory Set` associated with this Work Order Line Item. */
  readonly inventory_set_id?: number
  /** The ID of the VMRS Reason for Repair associated with this Work Order Line Item. */
  readonly vmrs_reason_for_repair_id?: number
  /** The ID of the VMRS System Group associated with this Work Order Line Item. */
  readonly vmrs_system_group_id?: number
  /** The ID of the VMRS System associated with this Work Order Line Item. */
  readonly vmrs_system_id?: number
  /** The ID of the VMRS Assembly associated with this Work Order Line Item. */
  readonly vmrs_assembly_id?: number
  /** The ID of the VMRS Component associated with this Work Order Line Item. */
  readonly vmrs_component_id?: number
  readonly labor_time_entries_attributes?: readonly {
    readonly started_at?: string
    readonly ended_at?: string
    readonly contact_id?: number | null
  }[]
}

export interface FleetioWorkOrderLineItemsAttributes {
  /** The ID of this Work Order Line Item. */
  readonly id?: number
  /** The Type of the item associated with this Work Order Line Item. */
  readonly item_type?: "Issue" | "ServiceTask"
  /** The name of the item associated with this Work Order Line Item. */
  readonly item_name?: string
  /** A description of this Work Order Line Item. */
  readonly description?: string
  /** The ID of the item associated with this Work Order Line Item. */
  readonly item_id?: number
  /** The cost of labor of this line item. */
  readonly labor_cost?: number
  /** The cost of `Parts` of this line item. */
  readonly parts_cost?: number
  /** The position of this line item in a list of line items. */
  readonly position?: number
  /** The subtotal of this line item. */
  readonly subtotal?: number
  readonly type?: "WorkOrderServiceTaskLineItem" | "WorkOrderFreeTextLineItem"
  /** The ID of the VMRS Reason for Repair associated with this Work Order Line Item. */
  readonly vmrs_reason_for_repair_id?: number
  /** The ID of the VMRS System Group associated with this Work Order Line Item. */
  readonly vmrs_system_group_id?: number
  /** The ID of the VMRS System associated with this Work Order Line Item. */
  readonly vmrs_system_id?: number
  /** The ID of the VMRS Assembly associated with this Work Order Line Item. */
  readonly vmrs_assembly_id?: number
  /** The ID of the VMRS Component associated with this Work Order Line Item. */
  readonly vmrs_component_id?: number
  /** The IDs of any `Issues` associated with this Work Order Line Item. */
  readonly issue_ids?: readonly number[]
  /** A list of any `Work Order Sub Line Items` to be added. */
  readonly work_order_sub_line_items_attributes?: readonly FleetioWorkOrderSubLineItemsAttributes[]
  /** A list of any `Work Order Part Line Items` to be added. */
  readonly work_order_part_line_items_attributes?: readonly FleetioWorkOrderSubLineItemsAttributes[]
  /** A list of any `Work Order Labor Line Items` to be added. */
  readonly work_order_labor_line_items_attributes?: readonly FleetioWorkOrderSubLineItemsAttributes[]
}

export interface FleetioWorkOrderCreateInput {
  /** The date and time at which this Work Order was issued. */
  readonly issued_at: string
  /** The date and time at which this Work Order was started. */
  readonly started_at?: string
  /** The date and time at which this Work Order was completed. */
  readonly completed_at?: string
  readonly work_order_status_id: number
  /** The number of the `Invoice` associated with this Work Order. */
  readonly invoice_number?: string
  readonly vendor_id?: number | null
  /** The name of the `Vendor` associated with this Work Order. */
  readonly vendor_name?: string
  readonly vehicle_id: number
  /** The name of the `Vehicle` associated with this Work Order. */
  readonly vehicle_name?: string
  /** The type of discount applied to this Work Order. */
  readonly discount_type?: "percentage" | "amount"
  /** The discount amount in decimal currency units applied to this Work Order. */
  readonly discount?: number
  /** The percentage of the discount applied to this Work Order. */
  readonly discount_percentage?: number
  /** The percentage of the parts markup applied to this Work Order. */
  readonly parts_markup_percentage?: number
  /** The type of parts markup to apply to this record. */
  readonly parts_markup_type?: "fixed" | "percentage"
  /** The amount of the parts markup applied to this Work Order. */
  readonly parts_markup?: number
  /** The percentage of the labor markup applied to this Work Order. */
  readonly labor_markup_percentage?: number
  /** The type of labor markup to apply to this record. */
  readonly labor_markup_type?: "fixed" | "percentage"
  /** The amount of the labor markup applied to this Work Order. */
  readonly labor_markup?: number
  /** The percentage of the first tax applied to this Work Order. */
  readonly tax_1_percentage?: number
  /** The type of tax to apply to this record. */
  readonly tax_1_type?: FleetioTaxType | null
  /** The amount of the first tax applied to this Work Order. */
  readonly tax_1?: number
  /** The percentage of the second tax applied to this Work Order. */
  readonly tax_2_percentage?: number
  /** The type of tax to apply to this record. */
  readonly tax_2_type?: FleetioTaxType | null
  /** The amount of the second tax applied to this Work Order. */
  readonly tax_2?: number
  readonly issued_by_id?: number | null
  readonly contact_id?: number | null
  /** A comma separated list of tags associated with this record. */
  readonly label_list?: string
  /** The number of the `Purchase Order` associated with this Work Order. */
  readonly purchase_order_number?: string
  /** A description of this Work Order. */
  readonly description?: string
  /** The number to be applied to this Work Order. */
  readonly number?: number
  /** A Work Order may also be associated with a Meter Entry. */
  readonly meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  /** A Work Order may also be associated with a secondary Meter Entry. */
  readonly secondary_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  /** The meter reading at the start of this Work Order. */
  readonly starting_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  /** The meter reading at the end of this Work Order. */
  readonly ending_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  /** The secondary meter reading at the start of this Work Order. */
  readonly starting_secondary_meter_entry_attributes?: {
    readonly value?: number
    readonly void?: boolean
  }
  /** The secondary meter reading at the end of this Work Order. */
  readonly ending_secondary_meter_entry_attributes?: {
    readonly value?: number
    readonly void?: boolean
  }
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** Use start meter for completion meter? */
  readonly ending_meter_same_as_start?: boolean
  readonly vmrs_repair_priority_class_id?: number | null
  /** The date and time at which this Work Order is scheduled. */
  readonly scheduled_at?: string
  /** The date and time at which this Work Order is expected to be completed. */
  readonly expected_completed_at?: string
  /** A list of `Comments` to be added to this Work Order. */
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
  /** A list of `Work Order Line Items` to be added to this Work Order. */
  readonly work_order_line_items_attributes?: readonly FleetioWorkOrderLineItemsAttributes[]
  /** A list of `Work Order Sub Line Items` to be added to this Work Order. */
  readonly work_order_sub_line_items_attributes?: readonly FleetioWorkOrderSubLineItemsAttributes[]
  /** A list of `Issues` to be added to this Work Order. */
  readonly issue_ids?: readonly (number | null)[]
  /** A list of `Labels` to be added to this Work Order. */
  readonly label_ids?: readonly (number | null)[]
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
  /** When `true`, any new `Service Task Line Item` in the request whose Service Task has a linked Inspection Form automatically gets a corresponding `Inspection Form Sub Line Item`, provided the work order's asset has an active Inspection Schedule for that form. */
  readonly auto_link_inspection_line_items?: boolean
}

export type FleetioWorkOrderUpdateInput = Partial<FleetioWorkOrderCreateInput>

export interface FleetioWorkOrderLineItemSort {
  readonly id?: FleetioSortDirection
}

export interface FleetioWorkOrderLineItemSubLineItemAttributes {
  /** The ID of an existing sub line item. */
  readonly id?: number
  /** The parent Work Order ID. */
  readonly work_order_id?: number
  /** The ID of the Part or Contact associated with this sub line item. */
  readonly item_id?: number
  readonly item_type?: "Part" | "Contact"
  /** The quantity of labor or parts for this sub line item. */
  readonly quantity?: number
  /** The cost per unit of labor or parts for this sub line item. */
  readonly unit_cost?: number
  /** The subtotal of this sub line item. */
  readonly subtotal?: number
  /** The position of this sub line item in the list of sub line items. */
  readonly position?: number
  /** Set to `true` along with the `id` and `item_type` of an existing sub line item to delete it when updating a Work Order Line Item. */
  readonly _destroy?: boolean
}

export interface FleetioWorkOrderPartLineItemAttributes {
  /** The parent Work Order ID. */
  readonly work_order_id?: number
  /** The ID of the Part associated with this part sub line item. */
  readonly item_id?: number
  readonly item_type?: "Part"
  /** The quantity of the Part for this part sub line item. */
  readonly quantity?: number
  /** The cost per unit of the Part for this part sub line item. */
  readonly unit_cost?: number
  /** The subtotal of the Part for this part sub line item. */
  readonly subtotal?: number
  /** The position of this part sub line item in the list of sub line items. */
  readonly position?: number
}

export interface FleetioWorkOrderLaborLineItemAttributes {
  /** The parent Work Order ID. */
  readonly work_order_id?: number
  /** The ID of the Contact associated with this labor sub line item. */
  readonly item_id?: number
  readonly item_type?: "Contact"
  /** The quantity of labor for this labor sub line item. */
  readonly quantity?: number
  /** The cost per unit of labor for this labor sub line item. */
  readonly unit_cost?: number
  /** The subtotal of this labor sub line item. */
  readonly subtotal?: number
  /** The position of this labor sub line item in the list of sub line items. */
  readonly position?: number
}

export interface FleetioWorkOrderLineItemCreateInput {
  readonly type?: "WorkOrderServiceTaskLineItem" | "WorkOrderFreeTextLineItem"
  /** The Type of the item associated with the Work Order Line Item */
  readonly item_type?: "Issue" | "ServiceTask"
  /** The ID of the item associated with this Work Order Line Item. */
  readonly item_id?: number
  readonly description?: string
  /** The IDs of any `Issues` associated with this Work Order Line Item. */
  readonly issue_ids?: readonly number[]
  /** The cost of labor of this line item. */
  readonly labor_cost?: number
  /** The cost of `Parts` of this line item. */
  readonly parts_cost?: number
  /** The subtotal of this line item. */
  readonly subtotal?: number
  /** The ID of the VMRS Reason for Repair associated with this Work Order Line Item. */
  readonly vmrs_reason_for_repair_id?: number
  /** The ID of the VMRS System Group associated with this Work Order Line Item. */
  readonly vmrs_system_group_id?: number
  /** The ID of the VMRS System associated with this Work Order Line Item. */
  readonly vmrs_system_id?: number
  /** The ID of the VMRS Assembly associated with this Work Order Line Item. */
  readonly vmrs_assembly_id?: number
  /** The ID of the VMRS Component associated with this Work Order Line Item. */
  readonly vmrs_component_id?: number
  /** The sub line items associated with this Work Order Line Item. */
  readonly work_order_sub_line_items_attributes?: readonly FleetioWorkOrderLineItemSubLineItemAttributes[]
  /** The part line items associated with this Work Order Line Item. */
  readonly work_order_part_line_items_attributes?: readonly FleetioWorkOrderPartLineItemAttributes[]
  /** The labor line items associated with this Work Order Line Item. */
  readonly work_order_labor_line_items_attributes?: readonly FleetioWorkOrderLaborLineItemAttributes[]
  /** When `true`, any new `Service Task Line Item` in the request whose Service Task has a linked Inspection Form automatically gets a corresponding `Inspection Form Sub Line Item`, provided the work order's asset has an active Inspection Schedule for that form. */
  readonly auto_link_inspection_line_items?: boolean
}

/** A Work Order Line Item */
export interface FleetioWorkOrderLineItemCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The title of this line item. */
  readonly title?: string | null
  /** A description of this Work Order Line Item. */
  readonly description?: string | null
  /** The position of this Work Order Line Item in a list of Work Order Line Items. */
  readonly position?: number | null
  /** The ID of the item associated with this Work Order Line Item. */
  readonly item_id: number
  /** The type of item associated with this Work Order Line Item. */
  readonly item_type: "Issue" | "ServiceTask"
  /** The ID of the `Work Order` that this line item belongs to. */
  readonly work_order_id: number
  /** The cost of `Parts` in cents of this line item. */
  readonly parts_cost_cents: number
  /** The cost of labor in cents of this line item. */
  readonly labor_cost_cents: number
  /** The ID of the `Service Reminder` associated with this line item, if applicable. */
  readonly service_reminder_id?: number | null
  /** The subtotal in cents of this line item. */
  readonly subtotal_cents: string
  readonly work_order_line_item_id?: number | null
  readonly vehicle_id?: number | null
  readonly vehicle_archived_at?: string | null
  readonly vmrs_system_id?: number | null
  readonly vmrs_assembly_id?: number | null
  readonly vmrs_component_id?: number | null
  readonly vmrs_reason_for_repair_id?: number | null
  readonly vmrs_system_group_id?: number | null
}

export type FleetioWorkOrderLineItemUpdateInput = Partial<FleetioWorkOrderLineItemCreateInput>

/** A Work Order Status */
export interface FleetioWorkOrderStatus {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The name of the Work Order Status. */
  readonly name: string
  /** The description of the Work Order Status. */
  readonly description: string | null
  /** The color of the Work Order Status seen in the UI. */
  readonly color: string | null
  /** Whether or not this is the default Work Order Status applied to new `Work Orders`. */
  readonly default: boolean
  /** Whether Work Orders will be set to `completed` when they are moved to this status. */
  readonly completed: boolean
  /** The position of this Work Order Status in the list of statuses. */
  readonly position: number
  /** The number of `Work Orders` that are currently in this status. */
  readonly work_orders_count: number
}

export interface FleetioWorkOrderStatusFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly color?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioWorkOrderStatusSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}
