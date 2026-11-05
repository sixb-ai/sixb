import type { FleetioComment } from "./comments"
import type {
  FleetioEqFilter,
  FleetioLikeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type {
  FleetioContactMini,
  FleetioImage,
  FleetioInspectionItem,
  FleetioVehicleMini,
} from "./shared"

/** An Inspection Form */
export interface FleetioInspectionForm {
  /** The ID of the Inspection Form. */
  readonly id?: number
  /** The title or name of the Inspection Form. */
  readonly title?: string
  /** A brief description or explanation of the Inspection Form's purpose or requirements. */
  readonly description?: string | null
  /** The date and time when the Inspection Form was last updated. */
  readonly updated_at?: string
  /** The date and time when the Inspection Form was archived, if applicable. */
  readonly archived_at?: string | null
  /** Indicates whether live photos are required as part of the inspection. */
  readonly require_live_photo?: boolean
  /** The version number of the Inspection Form. */
  readonly version?: number | null
  /** The ID of the current version of the Inspection Form. */
  readonly current_form_version_id?: number | null
  /** Indicates whether the workflow allows assigning `Users` to `Vehicles` for inspections. */
  readonly workflow_assign_user_to_vehicle_enabled?: boolean
  readonly inspection_items?: readonly FleetioInspectionItem[]
}

/** An Inspection Form */
export interface FleetioInspectionFormSummary {
  /** The ID of the Inspection Form. */
  readonly id?: number
  /** The title or name of the Inspection Form. */
  readonly title?: string
  /** A brief description or explanation of the Inspection Form's purpose or requirements. */
  readonly description?: string | null
  /** The date and time when the Inspection Form was last updated. */
  readonly updated_at?: string
  /** The date and time when the Inspection Form was last updated. */
  readonly created_at?: string
  /** The date and time when the Inspection Form was archived, if applicable. */
  readonly archived_at?: string | null
  /** Indicates whether live photos are required as part of the inspection. */
  readonly require_live_photo?: boolean
  /** The version number of the Inspection Form. */
  readonly version?: number | null
  /** The ID of the current version of the Inspection Form. */
  readonly current_form_version_id?: number | null
}

export interface FleetioInspectionFormFilter {
  readonly title?: FleetioLikeOrEqFilter
  readonly color?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioInspectionFormSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioSubmittedInspectionItemDefinition {
  /** The label or name of the Inspection Item. */
  readonly label?: string
  /** The type or category of the Inspection Item. */
  readonly type?:
    | "InspectionDateItem"
    | "InspectionDatetimeItem"
    | "InspectionDropdownItem"
    | "InspectionFreeTextItem"
    | "InspectionInventoryAdjustmentItem"
    | "InspectionMeterEntryItem"
    | "InspectionNumericItem"
    | "InspectionPassFailItem"
    | "InspectionPhotoItem"
    | "InspectionSectionItem"
    | "InspectionSignatureItem"
    | "InspectionSingleCheckboxItem"
    | "InspectionTireReadingsItem"
  /** The label for a "Fail" result. */
  readonly fail_label?: string | null
  /** The label for a "Pass" result. */
  readonly pass_label?: string | null
  /** The label for a "Not Applicable" result. */
  readonly na_label?: string | null
  /** An array of options for an `InspectionDropdownItem`. */
  readonly dropdown_options?: readonly {
    readonly label?: string
    readonly position?: number
    readonly fail_if_chosen?: boolean
  }[]
  /** The maximum value for an `InspectionNumericItem`. */
  readonly numeric_range_max?: number | null
  /** The minimum value for an `InspectionNumericItem`. */
  readonly numeric_range_min?: number | null
  /** A dynamically generated list of settings describing required items as part of the inspection form. */
  readonly requirement_settings?: Readonly<Record<string, unknown>>
}

export interface FleetioSubmittedInspectionItem {
  /** This object contains the result of the Submitted Inspection Item. */
  readonly result?: Readonly<Record<string, unknown>>
  readonly id?: number
  /** The number of `Comments` related to this Inspection Item. */
  readonly comments_count?: number
  /** The number of Images related to this Inspection Item. */
  readonly images_count?: number
  readonly submitted_inspection_form_id?: number
  /** The latitude at which this Inspection Item was submitted. */
  readonly latitude?: number | null
  /** The longitude at which this Inspection Item was submitted. */
  readonly longitude?: number | null
  readonly inspection_item?: FleetioSubmittedInspectionItemDefinition
  readonly comments?: readonly FleetioComment[]
  readonly images?: readonly FleetioImage[]
  readonly meter_entry_value?: string | null
}

/** A Submitted Inspection Form */
export interface FleetioSubmittedInspectionForm {
  readonly id: number
  /** The date and time at which this Inspection Form was started. */
  readonly started_at: string
  /** The date and time at which this Inspection Form was submitted. */
  readonly submitted_at: string
  /** The date on which this Inspection Form was submitted, formatted as "Mon DD, YYYY" */
  readonly date: string
  /** The number of failed items on this Inspection Form. */
  readonly failed_items: number
  readonly vehicle_id: number
  /** The latitude at which this Inspection Form was started. */
  readonly starting_latitude: number | null
  /** The longitude at which this Inspection Form was started. */
  readonly starting_longitude: number | null
  /** The latitude at which this Inspection Form was submitted. */
  readonly submitted_latitude: string | null
  /** The longitude at which this Inspection Form was submitted. */
  readonly submitted_longitude: string | null
  /** The duration of time in words (eg; 15 minutes, about 1 hour) between when this Inspection Form was started and when it was submitted. */
  readonly duration: string | null
  readonly inspection_form: {
    readonly id?: number
    readonly title?: string
    readonly description?: string | null
  }
  readonly contact_id?: number | null
  /** The full name of the User that submitted this Inspection Form. */
  readonly user?: string
  readonly submitted_inspection_items: readonly FleetioSubmittedInspectionItem[]
  readonly work_order?: { readonly id?: number; readonly number?: number }
  /** The number of `Comments` on this Inspection Form. */
  readonly comments_count: number
  /** The number of images attached to this Inspection Form. */
  readonly images_count: number
}

/** A Submitted Inspection Form */
export interface FleetioSubmittedInspectionFormSummary {
  readonly id: number
  /** The date and time at which this Inspection Form was started. */
  readonly started_at: string
  /** The date and time at which this Inspection Form was submitted. */
  readonly submitted_at: string
  /** The date on which this Inspection Form was submitted */
  readonly date: string
  /** The number of failed items on this Inspection Form. */
  readonly failed_items: number
  /** The latitude at which this Inspection Form was started. */
  readonly starting_latitude: number | null
  /** The longitude at which this Inspection Form was started. */
  readonly starting_longitude: number | null
  /** The latitude at which this Inspection Form was submitted. */
  readonly submitted_latitude: string | null
  /** The longitude at which this Inspection Form was submitted. */
  readonly submitted_longitude: string | null
  readonly inspection_form: {
    readonly id?: number
    readonly title?: string
    readonly description?: string | null
  }
  /** A Contact */
  readonly user?: FleetioContactMini | null
  /** A Vehicle */
  readonly vehicle: FleetioVehicleMini
  readonly work_order?: { readonly id?: number; readonly number?: number }
}

export interface FleetioSubmittedInspectionFormFilter {
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
  readonly submitted_at?: FleetioRangeFilter
  readonly inspection_form_id?: FleetioEqFilter
  readonly inspection_form_version_id?: FleetioEqFilter
  readonly inspection_form_title?: FleetioLikeFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly user_id?: FleetioEqFilter
}

export interface FleetioSubmittedInspectionFormSort {
  readonly created_at?: FleetioSortDirection
  readonly submitted_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

/** An Inspection Schedule */
export interface FleetioInspectionSchedule {
  readonly id?: number
  /** Whether this Inspection Schedule is active. */
  readonly active: boolean
  readonly vehicle_id: number
  readonly inspection_form_id: number
  readonly updated_at?: string
  /** This describes the recurrence behavior of the Inspection Schedule. */
  readonly recurring_rule_description: string
  /** Whether this Inspection Schedule is overdue. */
  readonly overdue: boolean
  /** Whether this Inspection Schedule is due soon. */
  readonly due_soon: boolean
  /** The date on which this Inspection Schedule is next due. */
  readonly next_due?: string
  /** The relative time until this Inspection Schedule is next due. */
  readonly next_due_relative_time?: string
  /** The date on which this Inspection Schedule's recurrence behavior began. */
  readonly recurring_schedule_start_at?: string
  readonly upcoming_occurrences?: readonly string[]
}

/** An Inspection Schedule */
export interface FleetioInspectionScheduleSummary {
  readonly id?: number
  /** Whether this Inspection Schedule is active. */
  readonly active: boolean
  readonly vehicle_id: number
  /** The Id of the `InspectionForm` associated with this Inspection Schedule. */
  readonly inspection_form_id: number
  /** The Id of the most recent `SubmittedInspectionForm` for this Inspection Schedule. */
  readonly last_submission_id?: number | null
  readonly updated_at?: string
  readonly created_at?: string
  /** This describes the recurrence behavior of the Inspection Schedule. */
  readonly recurring_rule_description: string
  /** The date and time at which this Inspection Schedule's recurrence behavior began. */
  readonly recurring_schedule_start_at?: string | null
  /** The date and time at which this Inspection Schedule is next due. */
  readonly next_due_at?: string | null
  /** The date and time at which this Inspection Schedule was last sent. */
  readonly last_sent_at?: string | null
  /** The date and time of the last `SubmittedInspectionForm`. */
  readonly last_inspected_at?: string | null
  /** The status of this Inspection Schedule. */
  readonly inspection_schedule_status: "due_soon" | "overdue" | "ok"
  /** A Vehicle */
  readonly vehicle?: FleetioVehicleMini
  readonly relative_schedule?: boolean
  readonly reminder_days_before?: number | null
  readonly reminder_hour?: number | null
}

export interface FleetioInspectionScheduleStatusFilter {
  readonly eq: "ok" | "overdue" | "due_soon"
}

export interface FleetioInspectionScheduleFilter {
  readonly vehicle_id?: FleetioEqFilter
  readonly inspection_form_id?: FleetioEqFilter
  readonly active?: FleetioEqFilter
  readonly inspection_schedule_status?: FleetioInspectionScheduleStatusFilter
  readonly last_inspected_at?: FleetioRangeFilter
  readonly last_sent_at?: FleetioRangeFilter
  readonly next_due_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioInspectionScheduleSort {
  readonly id?: FleetioSortDirection
  readonly last_inspected_at?: FleetioSortDirection
  readonly last_sent_at?: FleetioSortDirection
  readonly next_due_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}
