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
  FleetioCommentsAttributes,
  FleetioContactMini,
  FleetioFaultRule,
} from "./shared"

/** An Issue Priority represents the priority level of an Issue. */
export interface FleetioIssuePriority {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id?: number
  /** Can be used to replace the default priority name provided. */
  readonly alias?: string | null
  /** The name of the Issue Priority. */
  readonly name?: string
  /** Indicates which icon will be shown for the Issue Priority. */
  readonly slug?: string
  /** A description providing more details about the Issue Priority. */
  readonly description?: string
  /** Indicates whether this Issue Priority will be set as default for new `Issues`. */
  readonly default?: boolean
  /** Indicates whether this Issue Priority is currently enabled. */
  readonly enabled?: boolean
  /** The position or order of the Issue Priority in a list or hierarchy. */
  readonly position?: number
}

export interface FleetioIssueAsset {
  readonly id?: number
  /** The name of the asset associated with the Issue. */
  readonly name?: string
  /** The URL to a medium-sized image of the asset associated with the Issue. */
  readonly image_url_medium?: string | null
  /** The current job for the asset associated with the Issue, if any. */
  readonly current_job?: { readonly name?: string; readonly number?: string } | null
}

/** An Issue */
export interface FleetioIssue {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** A unique identifier for the Issue. */
  readonly number: number
  /** A summary of the Issue. */
  readonly summary: string
  /** A longer description of the Issue. */
  readonly description: string | null
  /** The Issue's current state. */
  readonly state: "open" | "closed" | "resolved"
  /** The date and time at which this Issue was reported. */
  readonly reported_at: string | null
  /** The `Contact` ID of the `User` who reported this Issue. */
  readonly reported_by: { readonly id?: number } | null
  /** The type of the object which can resolve this Issue. */
  readonly resolvable_type: "ServiceEntry" | "WorkOrder" | null
  /** The date and time at which this Issue was resolved. */
  readonly resolved_at: string | null
  /** The `Contact` ID of the `User` that resolved this Issue. */
  readonly resolved_by: { readonly id?: number } | null
  /** Any notes associated with resolving this Issue. */
  readonly resolved_note: string
  /** The date and time at which this Issue was closed. */
  readonly closed_at: string | null
  /** The `Contact` ID of the `User` that closed this Issue. */
  readonly closed_by: { readonly id?: number } | null
  /** Any notes associated with closing this Issue. */
  readonly closed_note: string
  /** The date on which this Issue should be resolved by. */
  readonly due_date: string | null
  /** The meter value at which this Issue should be resolved by. */
  readonly due_meter_value: number | null
  /** The secondary meter value at which this Issue should be resolved by. */
  readonly due_secondary_meter_value: number | null
  /** Indicates whether the Issue is overdue. */
  readonly is_overdue: boolean
  /** An Issue Priority represents the priority level of an Issue. */
  readonly issue_priority?: FleetioIssuePriority
  /** The ID of the object which can resolve this Issue. */
  readonly resolvable: { readonly id?: number } | null
  /** Indicates if this Issue was created manually or by a workflow. */
  readonly creation_type: "manual" | "workflow"
  readonly attachment_permissions: FleetioAttachmentPermissions | null
  readonly asset: FleetioIssueAsset
  /** The asset type that has the Issue. */
  readonly asset_type: "Vehicle" | "Equipment"
  readonly submitted_inspection_form: { readonly id?: number } | null
  readonly fault: { readonly id?: number } | null
  /** The count of watchers associated with the Issue. */
  readonly watchers_count?: number
  /** The count of `Comments` associated with the Issue. */
  readonly comments_count?: number
  /** The count of images associated with the Issue. */
  readonly images_count?: number
  /** The count of documents associated with the Issue. */
  readonly documents_count?: number
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** An array of labels associated with the Issue. */
  readonly labels?: readonly {
    readonly id?: number
    readonly name?: string
    readonly color?: string
  }[]
  readonly is_watched?: boolean
}

export interface FleetioIssueSummaryVehicle {
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
  /** The current job for the vehicle associated with the Issue, if any. */
  readonly current_job?: { readonly name?: string; readonly number?: string } | null
}

export interface FleetioEquipmentMini {
  readonly id: number
  /** The name for this Equipment. */
  readonly name: string
  /** The name of the brand which makes this Equipment. */
  readonly brand: string | null
  /** The model name of this Equipment. */
  readonly model: string | null
  /** The serial number of this Equipment. */
  readonly serial_number: string | null
}

/** An Issue */
export interface FleetioIssueSummary {
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
  readonly vehicle?: FleetioIssueSummaryVehicle
  readonly equipment?: FleetioEquipmentMini | null
  /** A Contact */
  readonly reported_by?: FleetioContactMini | null
  /** A Fault Rule */
  readonly fault_rule?: FleetioFaultRule
  readonly labels?: readonly { readonly id?: number; readonly name?: string }[]
  readonly assigned_contacts?: readonly (FleetioContactMini | null)[]
  /** An Issue Priority represents the priority level of an Issue. */
  readonly issue_priority?: FleetioIssuePriority
  readonly summary?: string | null
  readonly attachment_permissions?: FleetioAttachmentPermissions
}

export interface FleetioIssueFilter {
  readonly number?: FleetioEqFilter
  readonly reported_by_id?: FleetioEqFilter
  readonly assigned_contact_ids?: FleetioIncludeFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly equipment_id?: FleetioEqFilter
  readonly labels?: FleetioIncludeFilter
  readonly state?: FleetioEqFilter
  readonly due_date?: FleetioEqOrRangeFilter
  readonly resolved_at?: FleetioRangeFilter
  readonly reported_at?: FleetioRangeFilter
  readonly closed_at?: FleetioRangeFilter
  readonly reopened_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioIssueSort {
  readonly due_date?: FleetioSortDirection
  readonly resolved_at?: FleetioSortDirection
  readonly reported_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioIssueCreateInput {
  /** The ID of the asset associated with the Issue. */
  readonly asset_id: number
  /** The type of the asset associated with the Issue. */
  readonly asset_type: "Vehicle" | "Equipment"
  /** A short summary of the Issue. */
  readonly summary: string
  /** A longer description of the Issue. */
  readonly description?: string
  /** The id of the `Contact` who reported this Issue. */
  readonly reported_by_id?: number
  /** The date and time this Issue is reported. */
  readonly reported_at: string
  /** The id of the associated `IssuePriority` for this Issue. */
  readonly issue_priority_id?: number
  /** A unique identifier for the Issue. */
  readonly number?: number
  /** The date on which this Issue should be resolved by. */
  readonly due_date?: string
  /** The meter value at which this Issue should be resolved by. */
  readonly due_meter_value?: number
  /** The secondary meter value at which this Issue should be resolved by. */
  readonly due_secondary_meter_value?: number
  /** The id of the `Fault` associated with this Issue. */
  readonly fault_id?: number
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** An Issue may be associated with a Meter Entry. */
  readonly meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  /** An Issue may be associated with a secondary Meter Entry. */
  readonly secondary_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
  /** An array of one or more document objects to add to the record. */
  readonly documents_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of one or more image objects to add to the record. */
  readonly images_attributes?: readonly FleetioAttachmentAttributes[]
  /** An array of ids of assigned `Contacts` related to the Issue. */
  readonly assigned_contact_ids?: readonly number[]
  readonly label_ids?: readonly number[]
}

export type FleetioIssueUpdateInput = Partial<FleetioIssueCreateInput>

export interface FleetioIssuePriorityFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioIssuePrioritySort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioIssueCloseInput {
  /** A note to add to the Issue when it is closed. */
  readonly note: string
}

export interface FleetioIssueResolveInput {
  /** A note to add to the Issue when it is resolved. */
  readonly note: string
}
