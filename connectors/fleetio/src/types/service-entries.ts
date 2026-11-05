import type { FleetioComment } from "./comments"
import type {
  FleetioIncludeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioServiceTask } from "./service-tasks"
import type {
  FleetioAttachmentAttributes,
  FleetioAttachmentPermissions,
  FleetioAutoIntegrateRepairOrderStatus,
  FleetioCommentsAttributes,
  FleetioDiscountType,
  FleetioDocument,
  FleetioEmbeddedIssue,
  FleetioEmbeddedServiceEntryLineItem,
  FleetioImage,
  FleetioLaborMarkupType,
  FleetioPartMarkupType,
  FleetioServiceEntryLineItemType,
  FleetioTaxType,
  FleetioVehicleMeterEntry,
  FleetioVehicleMini,
  FleetioVendorMini,
  FleetioVmrsReasonForRepairCode,
  FleetioVmrsSystemCode,
  FleetioWorkOrderVmrsRepairPriorityClass,
} from "./shared"

export interface FleetioServiceEntryInvoice {
  readonly id?: number
  /** The date and time when the Invoice was created. */
  readonly created_at?: string
  /** The PO number for the Invoice. */
  readonly po_number?: string
  /** The date and time when the Invoice was last updated. */
  readonly updated_at?: string
}

/** A Service Entry */
export interface FleetioServiceEntry {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** Indicates whether or not to include labor subtotals in tax calculations. */
  readonly tax_free_labor?: boolean
  /** The date and time at which the Service Entry was completed. */
  readonly completed_at: string | null
  /** A reference number for this Service Entry. */
  readonly reference: string | null
  /** The date and time at which the Service Entry was started. */
  readonly started_at: string | null
  /** The status of this Service Entry. */
  readonly status: "pending" | "completed"
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  /** General notes for this Service Entry. */
  readonly general_notes: string | null
  readonly vehicle_id: number
  /** The name of the `Vehicle` associated with this Service Entry. */
  readonly vehicle_name: string | null
  readonly vendor_id: number | null
  /** The name of the `Vendor` associated with this Service Entry. */
  readonly vendor_name: string | null
  readonly work_order_id: number | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** Indicates whether or not this Service Entry is a sample. */
  readonly is_sample: boolean
  /** The number of the `Work Order` this Service Entry is associated with. */
  readonly work_order_number: number | null
  /** The date of this Service Entry. */
  readonly date: string
  readonly service_entry_line_items: readonly FleetioEmbeddedServiceEntryLineItem[]
  readonly service_tasks: readonly FleetioServiceTask[]
  readonly issues: readonly FleetioEmbeddedIssue[]
  /** A Meter Entry */
  readonly meter_entry: FleetioVehicleMeterEntry | null
  /** A Meter Entry */
  readonly secondary_meter_entry?: FleetioVehicleMeterEntry | null
  /** The Vehicle Maintenance Reporting Standards (VMRS) Repair Priority Class for this Service Entry. */
  readonly vmrs_repair_priority_class: FleetioWorkOrderVmrsRepairPriorityClass | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  readonly auto_integrate_ro_id: number | null
  /** The Auto Integrate `Repair Order` link for this Service Entry. */
  readonly auto_integrate_ro_link?: string | null
  /** The Auto Integrate `Repair Order` status for this Service Entry. */
  readonly auto_integrate_repair_order_status: FleetioAutoIntegrateRepairOrderStatus | null
  /** The color applied to the Auto Integrate `Repair Order` status for this Service Entry. */
  readonly auto_integrate_repair_order_status_color: string | null
  /** An MSI Repair Order Invoice (pass expand[]=invoice in query to include in response) */
  readonly invoice?: FleetioServiceEntryInvoice | null
  /** The discount amount. */
  readonly discount?: number | null
  /** The type of discount applied to this record. */
  readonly discount_type?: FleetioDiscountType | null
  /** The discount percentage. */
  readonly discount_percentage?: number | null
  /** The fees amount. */
  readonly fees?: number
  /** The pre-tax subtotal amount. */
  readonly subtotal?: number
  /** The pre-tax subtotal amount for parts. */
  readonly parts_subtotal?: number
  /** The pre-tax subtotal amount for labor. */
  readonly labor_subtotal?: number
  /** The primary tax amount. */
  readonly tax_1?: number | null
  /** The primary tax percentage. */
  readonly tax_1_percentage?: number | null
  /** The primary tax type. */
  readonly tax_1_type?: string | null
  /** The secondary tax amount. */
  readonly tax_2?: number | null
  /** The secondary tax percentage. */
  readonly tax_2_percentage?: number | null
  /** The secondary tax type. */
  readonly tax_2_type?: string | null
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
  readonly total_amount?: number
  /** A list of the comments made on this record. */
  readonly comments: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count: number
  /** The sum, in seconds, of the duration of all labor line items of the Work Order that created this Service Entry, if applicable. */
  readonly labor_time_in_seconds?: number | null
  /** A list of the documents attached to this record. */
  readonly documents?: readonly FleetioDocument[]
  /** The number of documents attached to this record. */
  readonly documents_count: number
  /** A list of the images attached to this record. */
  readonly images: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count: number
}

/** A Service Entry */
export interface FleetioServiceEntrySummary {
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
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  /** A Vendor */
  readonly vendor?: FleetioVendorMini | null
  /** A Vehicle */
  readonly vehicle?: FleetioVehicleMini
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
  /** The sum, in seconds, of the duration of all labor line items of the Work Order that created this Service Entry, if applicable. */
  readonly labor_time_in_seconds?: number | null
}

export interface FleetioServiceEntryFilter {
  readonly reference?: FleetioLikeOrEqFilter
  readonly status?: FleetioIncludeFilter
  readonly labels?: FleetioIncludeFilter
  readonly completed_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioServiceEntrySort {
  readonly id?: FleetioSortDirection
  readonly completed_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
}

export interface FleetioServiceEntryLineItemAttributes {
  readonly id?: number
  readonly service_task_id?: number
  /** Denotes the type of the ServiceEntryLineItem */
  readonly type?: FleetioServiceEntryLineItemType
  /** Free text field, used for notes or description. */
  readonly description?: string
  /** Total labor cost for this line item. */
  readonly labor_cost?: number
  /** Total parts cost for this line item. */
  readonly parts_cost?: number
  /** Subtotal for this line item. */
  readonly subtotal?: number
  /** For nested line items. */
  readonly service_entry_line_item_id?: number
  /** An array of issue IDs that you want the line item to be linked to. */
  readonly issue_ids?: readonly string[]
  readonly vmrs_reason_for_repair_id?: number
  readonly vmrs_system_group_id?: number
  readonly vmrs_system_id?: number
  readonly vmrs_component_id?: number
  readonly vmrs_assembly_id?: number
}

export interface FleetioServiceEntryCreateInput {
  /** The date and time at which the Service Entry was completed. */
  readonly completed_at: string
  /** The date and time at which the Service Entry was started. */
  readonly started_at?: string
  readonly vehicle_id: number
  /** The VIN of the `Vehicle` associated with this Service Entry. */
  readonly vehicle_vin?: string
  readonly vendor_id?: number
  /** A reference number for this Service Entry. */
  readonly reference?: string
  /** A comma separated list of tags associated with this record. */
  readonly label_list?: string
  /** Any general notes about this Service Entry. */
  readonly general_notes?: string
  readonly vmrs_repair_priority_class_id?: number
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A Service Entry may be associated with a Meter Entry */
  readonly meter_entry_attributes: { readonly value?: number; readonly void?: boolean }
  /** A Service Entry may also be associated with a secondary Meter Entry */
  readonly secondary_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  readonly service_entry_line_items_attributes?: readonly FleetioServiceEntryLineItemAttributes[]
  /** The IDs of any Issues associated with this Service Entry. */
  readonly issue_ids?: readonly number[]
  /** The IDs of any Service Tasks associated with this Service Entry. */
  readonly service_task_ids?: readonly number[]
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
  /** The total cost of labor for this Service Entry. */
  readonly labor_subtotal?: number
  /** When `true`, preserves the submitted `total_amount` as a manually entered value instead of recalculating it from subtotals, discounts, taxes, fees, and markups. */
  readonly manual_total_amount?: boolean
  /** When `true`, preserves the submitted `parts_subtotal` and `labor_subtotal` as manually entered values instead of recalculating them from `Service Entry Line Item` costs. */
  readonly manual_parts_or_labor_subtotal?: boolean
  /** The total cost of `Parts` for this Service Entry. */
  readonly parts_subtotal?: number
  /** The subtotal amount of this Service Entry before any discounts or taxes. */
  readonly subtotal?: number
  /** The total discount amount for this Service Entry. */
  readonly discount?: number
  /** The total discount percentage for this Service Entry. */
  readonly discount_percentage?: number
  /** The type of discount applied to this record. */
  readonly discount_type?: FleetioDiscountType | null
  /** The first tax amount for this Service Entry. */
  readonly tax_1?: number
  /** The first tax percentage for this Service Entry. */
  readonly tax_1_percentage?: number
  /** The type of tax to apply to this record. */
  readonly tax_1_type?: FleetioTaxType | null
  /** The second tax amount for this Service Entry. */
  readonly tax_2?: number
  /** The second tax percentage for this Service Entry. */
  readonly tax_2_percentage?: number
  /** The type of tax to apply to this record. */
  readonly tax_2_type?: FleetioTaxType | null
  /** The grand total of this Service Entry. */
  readonly total_amount?: number
}

export type FleetioServiceEntryUpdateInput = Partial<FleetioServiceEntryCreateInput>

/** A Service Entry Line Item */
export interface FleetioServiceEntryLineItem {
  readonly id: number
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
  /** The pre-tax subtotal for this line item. */
  readonly subtotal?: number
  /** The parts cost for this line item. */
  readonly parts_cost?: number
  /** The labor cost for this line item. */
  readonly labor_cost?: number
  readonly vmrs_reason_for_repair: FleetioVmrsReasonForRepairCode | null
  readonly vmrs_system_group: FleetioVmrsSystemCode | null
  readonly vmrs_system: FleetioVmrsSystemCode | null
  readonly vmrs_assembly: FleetioVmrsSystemCode | null
  readonly vmrs_component: FleetioVmrsSystemCode | null
}

export interface FleetioServiceEntryLineItemSort {
  readonly id?: FleetioSortDirection
}

export interface FleetioServiceEntryLineItemCreateInput {
  /** Denotes the type of the ServiceEntryLineItem */
  readonly type?: FleetioServiceEntryLineItemType
  readonly service_task_id?: number
  /** A description of the service performed for this line item. */
  readonly description?: string
  /** IDs of any `Issues` this line item is linked to. */
  readonly issue_ids?: readonly number[]
  /** The cost of labor for this line item. */
  readonly labor_cost?: number
  /** The cost of `Parts` for this line item. */
  readonly parts_cost?: number
  /** Ignored if `labor_cost` and `parts_cost` is present. */
  readonly subtotal?: number
}

/** A Service Entry Line Item */
export interface FleetioServiceEntryLineItemCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  /** A title for this line item. */
  readonly title: string | null
  /** A description of the service performed for this line item. */
  readonly description: string | null
  /** The position of this line item in the list of line items. */
  readonly position: number | null
  readonly linking_source: "manual" | "automatic_algorithm" | "service_code_mapper" | null
  readonly vehicle_id: number
  /** For nested line items. */
  readonly service_entry_line_item_id: number | null
  /** If this line item is linked to a Service Reminder, this ID will be set. */
  readonly service_reminder_id: number | null
  readonly service_entry_id: number
  readonly service_task_id: number
  readonly service_code_id: number | null
  readonly import_id?: number | null
  /** The labor cost in cents for this line item. */
  readonly labor_cost_cents?: number
  /** The parts cost in cents for this line item. */
  readonly parts_cost_cents?: number
  /** The pre-tax subtotal in cents for this line item. */
  readonly subtotal_cents?: number
  readonly vmrs_system_id?: number | null
  readonly vmrs_assembly_id?: number | null
  readonly vmrs_component_id?: number | null
  readonly vmrs_reason_for_repair_id?: number | null
  readonly vmrs_system_group_id?: number | null
}

export type FleetioServiceEntryLineItemUpdateInput = Partial<FleetioServiceEntryLineItemCreateInput>
