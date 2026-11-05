import type {
  FleetioEqFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioAttachmentAttributes, FleetioVehicleMini, FleetioVendorMini } from "./shared"

/** An Expense Entry */
export interface FleetioExpenseEntry {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The total amount of the expense. */
  readonly total_amount?: number
  /** Additional comments. */
  readonly notes?: string | null
  readonly expense_entry_type_id?: number
  /** Name of the Expense Entry Type associated with this entry. */
  readonly expense_entry_type_name?: string
  /** Date and time of the expense. */
  readonly occurred_at?: string
  /** The ID of the associated `Vehicle`. */
  readonly vehicle_id?: number
  /** The name of the associated `Vehicle`. */
  readonly vehicle_name?: string
  readonly vendor_id?: number | null
  /** The name of the associated `Vendor`. */
  readonly vendor_name?: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
}

/** An Expense Entry */
export interface FleetioExpenseEntrySummary {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The total amount of the expense in cents. */
  readonly total_amount_cents?: number
  /** Additional comments. */
  readonly notes: string | null
  readonly expense_entry_type_id: number
  /** Name of the Expense Entry Type associated with this entry. */
  readonly expense_entry_type_name: string
  /** Date and time of the expense. */
  readonly occurred_at: string
  /** The ID of the associated `Vehicle`. */
  readonly vehicle_id: number
  /** The ID of the associated `Vendor` */
  readonly vendor_id: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A Vehicle */
  readonly vehicle?: FleetioVehicleMini
  /** A Vendor */
  readonly vendor?: FleetioVendorMini | null
}

export interface FleetioExpenseEntryFilter {
  readonly vendor_id?: FleetioEqFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly expense_entry_type_id?: FleetioEqFilter
  readonly occurred_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioExpenseEntrySort {
  readonly id?: FleetioSortDirection
  readonly occurred_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioExpenseEntryCreateInput {
  readonly vehicle_id: number
  readonly expense_entry_type_id: number
  readonly vendor_id?: number
  /** The total amount of this Expense Entry, in cents. */
  readonly total_amount_cents: number
  /** Date and time of the expense. */
  readonly occurred_at: string
  /** Additional comments. */
  readonly notes?: string
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
}

/** An Expense Entry */
export interface FleetioExpenseEntryCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The ID of the `Account` that owns this Expense Entry. */
  readonly account_id?: number
  /** Additional comments. */
  readonly notes?: string | null
  readonly expense_entry_type_id?: number
  /** Date and time of the expense. */
  readonly occurred_at?: string
  /** The ID of the associated `Vehicle`. */
  readonly vehicle_id?: number
  readonly vendor_id?: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The ID of the associated `Acquisition`, if applicable. */
  readonly billable_id?: number | null
  /** The billable type, if applicable. */
  readonly billable_type?: "Acquisition" | null
  /** Whether or not this record is being watched in bulk. */
  readonly bulk_watch_record?: boolean
  /** The number of `Comments` on this record. */
  readonly comments_count?: number
  /** The number of documents attached to this record. */
  readonly documents_count?: number
  /** The number of images attached to this record. */
  readonly images_count?: number
  /** The ID of the `Import` that created this record, if applicable. */
  readonly import_id?: number | null
  /** Whether or not this record is sample data. */
  readonly is_sample?: boolean
  /** The ID of the associated recurring Expense Entry, if applicable. */
  readonly recurring_expense_entry_id?: number | null
  /** Whether or not to skip automatic watchers callbacks. */
  readonly skip_automatic_watchers_callbacks?: boolean
  /** The total amount of the expense. */
  readonly total_amount_cents?: string
  /** The date and time the associated `Vehicle` was archived, if applicable. */
  readonly vehicle_archived_at?: string | null
  /** Options related to watching the record. */
  readonly watchable_options?: Readonly<Record<string, unknown>>
}

export type FleetioExpenseEntryUpdateInput = Partial<FleetioExpenseEntryCreateInput>

/** An Expense Entry Type */
export interface FleetioExpenseEntryType {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of the Expense Entry Type. */
  readonly name: string
}

export interface FleetioExpenseEntryTypeFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioExpenseEntryTypeSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioExpenseEntryTypeCreateInput {
  /** The name of this Expense Entry Type. */
  readonly name: string
}

/** An Expense Entry Type */
export interface FleetioExpenseEntryTypeCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  readonly name: string
  /** @deprecated */
  readonly description: string | null
}

export type FleetioExpenseEntryTypeUpdateInput = Partial<FleetioExpenseEntryTypeCreateInput>
