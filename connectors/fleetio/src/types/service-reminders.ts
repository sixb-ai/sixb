import type { FleetioComment } from "./comments"
import type { FleetioEqFilter, FleetioRangeFilter, FleetioSortDirection } from "./common"
import type { FleetioServiceEntry } from "./service-entries"
import type {
  FleetioAttachmentPermissions,
  FleetioCommentsAttributes,
  FleetioVehicleMini,
  FleetioVmrsReasonForRepair,
} from "./shared"

export type FleetioFrequency =
  | "day"
  | "week"
  | "month"
  | "year"
  | "days"
  | "weeks"
  | "months"
  | "years"
  | null

export interface FleetioServiceProgramLineItemServiceTaskDefaultVmrsSystemGroup {
  readonly id?: number
  /** The system group code of this system group. */
  readonly system_group_code?: string
  /** The name of this system group. */
  readonly system_group_name?: string
  /** The system code of this system group. */
  readonly system_code?: string
  /** The name of this system. */
  readonly system_name?: string
  /** The assembly code of this system group. */
  readonly assembly_code?: string
  /** The assembly name related to this system group. */
  readonly assembly_name?: string
  /** The component code of this system group. */
  readonly component_code?: string
  /** The component name related to this system group. */
  readonly component_name?: string
  /** Whether or not this system group is enabled. */
  readonly enabled?: boolean
}

export interface FleetioServiceProgramLineItemServiceTaskDefaultVmrsComponent {
  readonly id?: number
  /** The system group code of the default VMRS component. */
  readonly system_group_code?: string
  /** The name of the default VMRS system group. */
  readonly system_group_name?: string
  /** The system code of the default VMRS component. */
  readonly system_code?: string
  /** The name of the default VMRS system. */
  readonly system_name?: string
  /** The assembly code of the default VMRS component. */
  readonly assembly_code?: string
  /** The name of the default VMRS assembly. */
  readonly assembly_name?: string
  /** The component code of the default VMRS component. */
  readonly component_code?: string
  /** The name of the default VMRS component. */
  readonly component_name?: string
}

export interface FleetioServiceProgramLineItemServiceTask {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of this Service Task. */
  readonly name?: string
  /** A description of this Service Task. */
  readonly description?: string | null
  /** The expected time to complete this Service Task in seconds. */
  readonly expected_duration_in_seconds?: number | null
  /** The subtasks array within a parent subtasks array will always be empty. */
  readonly subtasks?: readonly (FleetioServiceProgramLineItemServiceTask | null)[]
  readonly default_vmrs_reason_for_repair?: FleetioVmrsReasonForRepair | null
  readonly default_vmrs_system_group?: FleetioServiceProgramLineItemServiceTaskDefaultVmrsSystemGroup | null
  readonly default_vmrs_system?: FleetioServiceProgramLineItemServiceTaskDefaultVmrsSystemGroup | null
  readonly default_vmrs_assembly?: FleetioServiceProgramLineItemServiceTaskDefaultVmrsSystemGroup | null
  readonly default_vmrs_component?: FleetioServiceProgramLineItemServiceTaskDefaultVmrsComponent | null
}

export interface FleetioServiceProgramLineItemServiceProgram {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of the Service Program. */
  readonly name?: unknown
}

export interface FleetioServiceProgramLineItem {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The number of time units according to `time_frequency` between each occurrence of the `Service Task`(s) of this Service Program line item. */
  readonly time_interval?: number
  readonly time_frequency?: FleetioFrequency | null
  /** The meter interval of which this Service Program line item takes place. */
  readonly meter_interval?: number
  /** The secondary meter interval of which this Service Program line item takes place. */
  readonly secondary_meter_interval?: number | null
  /** The number of time units according to `due_soon_time_threshold_frequency` between `due_soon_at` occurrences. */
  readonly due_soon_time_threshold_interval?: number | null
  readonly due_soon_time_threshold_frequency?: FleetioFrequency | null
  /** The meter value threshold to which this Service Program line item will be due soon. */
  readonly due_soon_meter_threshold?: number | null
  /** The secondary meter value threshold to which this Service Program line item will be due soon. */
  readonly due_soon_secondary_meter_threshold?: number | null
  /** Any `Service Tasks` associated with this Service Program line item. */
  readonly service_tasks?: readonly (FleetioServiceProgramLineItemServiceTask | null)[]
  /** Basic information about the parent Service Program. */
  readonly service_program?: FleetioServiceProgramLineItemServiceProgram
}

/** A Service Reminder */
export interface FleetioServiceReminder {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** Indicates whether the Service Reminder is currently active. */
  readonly active?: boolean
  readonly vehicle_id?: number
  readonly service_task_id?: number | null
  /** The name of the `Service Task` associated with the Service Reminder, if applicable. */
  readonly service_task_name?: string | null
  /** The description of service performed in the `Service Task` associated with the Service Reminder, if applicable. */
  readonly service_task_description?: string | null
  /** The number of time units according to `time_frequency` between each occurrence of the Service Reminder. */
  readonly time_interval?: number | null
  readonly time_frequency?: FleetioFrequency | null
  /** The date and time when the Service Reminder is next due. */
  readonly next_due_at?: string | null
  /** The date and time when the Service Reminder will be considered due soon. */
  readonly due_soon_at?: string | null
  /** The number of time units according to `due_soon_time_threshold_frequency` between `due_soon_at` occurrences. */
  readonly due_soon_time_threshold_interval?: number | null
  readonly due_soon_time_threshold_frequency?: FleetioFrequency | null
  /** The date and time at which the vehicle associated with the Service Reminder was archived, if applicable. */
  readonly vehicle_archived_at?: string | null
  /** The forecasted date and time for the next due service. */
  readonly forecasted_next_due_at?: string | null
  /** The forecasted date and time for the Service Reminder to be due soon. */
  readonly forecasted_due_soon_at?: string | null
  /** Indicates whether the Service Reminder has a starting interval. */
  readonly starting_interval?: boolean | null
  /** The starting meter interval for this Service Reminder. */
  readonly starting_meter_interval?: string | null
  /** The starting secondary meter interval for this Service Reminder. */
  readonly starting_secondary_meter_interval?: string | null
  /** The starting time interval according to `starting_time_frequency` for time-based Service Reminders, if applicable. */
  readonly starting_time_interval?: number | null
  readonly starting_time_frequency?: FleetioFrequency | null
  /** The date and time until which the Service Reminder is snoozed. */
  readonly snooze_until?: string | null
  /** Any incomplete Work Orders associated with the Service Reminder. */
  readonly incomplete_work_orders?: readonly ({
    readonly id?: number
    readonly number?: number
    readonly issued_date?: string
  } | null)[]
  /** Any `Service Task Subtasks` associated with the Service Reminder. */
  readonly service_task_subtasks?: readonly ({
    readonly id?: number
    readonly name?: string
    readonly description?: string
  } | null)[]
  /** The number of secondary meter units between each occurrence of the Service Reminder. */
  readonly secondary_meter_interval?: string | null
  /** The secondary meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_secondary_meter_value?: string | null
  /** The secondary meter value at which the Service Reminder is due soon, if applicable. */
  readonly due_soon_secondary_meter_value?: string | null
  /** The secondary meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_secondary_meter_threshold?: string | null
  /** The name of the Service Reminder status, if applicable. */
  readonly service_reminder_status_name?: string | null
  /** Indicates whether the Service Reminder is associated with a secondary meter. */
  readonly secondary_meter?: boolean
  /** The meter interval of which this Service Reminder takes place. */
  readonly meter_interval?: string | null
  /** The meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_meter_value?: string | null
  /** The meter value at which the Service Reminder is due soon, if applicable. */
  readonly due_soon_meter_value?: string | null
  /** The meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_meter_threshold?: string | null
  /** The remaining meter units until the Service Reminder is due. */
  readonly meter_remaining_until_due?: number | null
  /** The remaining secondary meter units until the Service Reminder is due. */
  readonly secondary_meter_remaining_until_due?: number | null
  readonly vehicle_meter_unit?: "mi" | "km" | "hr"
  readonly vehicle_secondary_meter_unit?: "mi" | "km" | "hr" | null
  /** The forecasted date and time for the primary Service Reminder to be due soon. */
  readonly forecasted_primary_due_soon_at?: string | null
  /** The forecasted date and time for the next primary due Service Reminder. */
  readonly forecasted_primary_next_due_at?: string | null
  /** The forecasted date and time for the secondary Service Reminder to be due soon. */
  readonly forecasted_secondary_due_soon_at?: string | null
  /** The forecasted date and time for the next secondary due Service Reminder. */
  readonly forecasted_secondary_next_due_at?: string | null
  /** A list of `Users` associated with the Service Reminder. */
  readonly users?: readonly { readonly id?: number; readonly name?: string | null }[]
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** A Service Entry */
  readonly latest_occurrence?: FleetioServiceEntry | null
  readonly service_program_line_item?: FleetioServiceProgramLineItem | null
  /** The count of watchers associated with the record. */
  readonly watchers_count?: number
  /** Indicates whether the record is being watched. */
  readonly is_watched?: boolean
  /** A list of the comments made on this record. */
  readonly comments?: readonly FleetioComment[]
  /** The number of comments made on this record. */
  readonly comments_count?: number
}

/** A Service Task */
export interface FleetioServiceTaskMini {
  readonly id?: number
  /** A name for this Service Task. */
  readonly name?: string
  /** A description of this Service Task. */
  readonly description?: string | null
  /** The expected duration in seconds this Service Task should take to complete. */
  readonly expected_duration_in_seconds?: number | null
}

/** A Service Reminder */
export interface FleetioServiceReminderSummary {
  readonly id?: number
  /** Indicates whether the Service Reminder is currently active. */
  readonly active?: boolean
  /** The ID of the `Vehicle` associated with this Service Reminder. */
  readonly vehicle_id?: number
  /** The ID of the `ServiceTask` associated with this Service Reminder. */
  readonly service_task_id?: number | null
  /** The count of `Comments` associated with this Service Reminder. */
  readonly comments_count?: number
  /** The count of `Users` watching this Service Reminder. */
  readonly watchers_count?: number
  /** Indicates whether the Service Reminder has a starting interval. */
  readonly starting_interval?: boolean | null
  /** The starting meter interval for the primary meter for this Service Reminder. */
  readonly starting_primary_meter_interval?: string | null
  /** The starting secondary meter interval for this Service Reminder. */
  readonly starting_secondary_meter_interval?: string | null
  /** The number of primary meter units between each occurance of this Service Reminder. */
  readonly primary_meter_interval?: string | null
  /** The number of secondary meter units between each occurrence of the Service Reminder. */
  readonly secondary_meter_interval?: string | null
  /** The primary meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_primary_meter_value?: string | null
  /** The secondary meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_secondary_meter_value?: string | null
  /** The primary meter value at which the Service Reminder is due soon, if applicable. */
  readonly due_soon_primary_meter_value?: string | null
  /** The primary meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_primary_meter_threshold?: string | null
  /** The secondary meter value at which the Service Reminder is due soon, if applicable. */
  readonly due_soon_secondary_meter_value?: string | null
  /** The secondary meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_secondary_meter_threshold?: string | null
  /** The starting time interval according to `starting_time_frequency` for time-based Service Reminders, if applicable. */
  readonly starting_time_interval?: number | null
  readonly starting_time_frequency?: FleetioFrequency | null
  /** The number of time units according to `time_frequency` between each occurrence of the Service Reminder. */
  readonly time_interval?: number | null
  readonly time_frequency?: FleetioFrequency | null
  /** The date and time until which the Service Reminder is snoozed. */
  readonly snooze_until?: string | null
  /** The date and time when the Service Reminder is next due. */
  readonly next_due_at?: string | null
  /** The date and time when the Service Reminder will be considered due soon. */
  readonly due_soon_at?: string | null
  /** The number of time units according to `due_soon_time_threshold_frequency` between `due_soon_at` occurrences. */
  readonly due_soon_time_threshold_interval?: number | null
  readonly due_soon_time_threshold_frequency?: FleetioFrequency | null
  /** The forecasted date and time for the primary Service Reminder to be due soon. */
  readonly forecasted_primary_due_soon_at?: string | null
  /** The forecasted date and time for the next primary due Service Reminder. */
  readonly forecasted_primary_next_due_at?: string | null
  /** The forecasted date and time for the secondary Service Reminder to be due soon. */
  readonly forecasted_secondary_due_soon_at?: string | null
  /** The forecasted date and time for the next secondary due Service Reminder. */
  readonly forecasted_secondary_next_due_at?: string | null
  /** The forecasted date and time for the next due service. */
  readonly forecasted_next_due_at?: string | null
  /** The forecasted date and time for the Service Reminder to be due soon. */
  readonly forecasted_due_soon_at?: string | null
  /** The date and time at which the vehicle associated with the Service Reminder was archived, if applicable. */
  readonly vehicle_archived_at?: string | null
  /** The date and time this Service reminder was created. */
  readonly created_at?: string
  /** The date and time this Service Reminder was last updated. */
  readonly updated_at?: string
  /** The status of this Service Reminder. */
  readonly service_reminder_status?: "due_soon" | "overdue" | "ok" | "snoozed"
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** A Vehicle */
  readonly vehicle?: FleetioVehicleMini
  /** A Service Task */
  readonly service_task?: FleetioServiceTaskMini | null
}

export interface FleetioServiceReminderStatusFilter {
  readonly eq: "ok" | "overdue" | "due_soon" | "snoozed"
}

export interface FleetioServiceReminderFilter {
  readonly vehicle_id?: FleetioEqFilter
  readonly service_task_id?: FleetioEqFilter
  readonly service_reminder_status?: FleetioServiceReminderStatusFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioServiceReminderSort {
  readonly id?: FleetioSortDirection
  readonly next_due_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export type FleetioFrequencyParameter = "days" | "weeks" | "months" | "years"

export interface FleetioServiceReminderCreateInput {
  readonly service_task_id: number
  /** The meter interval of which this Service Reminder should occur. */
  readonly meter_interval: number
  /** The secondary meter interval of which this Service Reminder should occur. */
  readonly secondary_meter_interval?: number
  /** Indicates whether the Service Reminder is associated with a secondary meter. */
  readonly secondary_meter?: boolean
  /** The number of time units according to `time_frequency` between each occurrence of the Service Reminder. */
  readonly time_interval?: number
  readonly time_frequency?: FleetioFrequencyParameter
  /** Indicates whether the Service Reminder is overridden. */
  readonly overridden?: boolean
  /** The meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_meter_value?: number
  /** The secondary meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_secondary_meter_value?: number
  /** We recommend using ISO-8601 formatted dates to avoid ambiguity. */
  readonly next_due_at?: string
  /** The meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_meter_threshold?: number
  /** The secondary meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_secondary_meter_threshold?: number
  /** Indicates whether the Service Reminder is currently active. */
  readonly active?: boolean
  /** The number of time units according to `due_soon_time_threshold_frequency` between `due_soon_at` occurrences. */
  readonly due_soon_time_threshold_interval?: number
  readonly due_soon_time_threshold_frequency?: FleetioFrequencyParameter
  readonly vehicle_id: number
  /** Indicates whether the Service Reminder has a starting interval. */
  readonly starting_interval?: boolean
  /** The starting meter interval for this Service Reminder. */
  readonly starting_meter_interval?: number
  /** The starting secondary meter interval for this Service Reminder. */
  readonly starting_secondary_meter_interval?: number
  /** The starting time interval according to `starting_time_frequency` for time-based Service Reminders, if applicable. */
  readonly starting_time_interval?: number
  readonly starting_time_frequency?: FleetioFrequencyParameter
  /** The date and time until which the Service Reminder will be snoozed. */
  readonly snooze_until?: string
  /** The IDs of any `Users` associated with the Service Reminder. */
  readonly user_ids?: readonly number[]
  /** The IDs of any `Users` to watch the Service Reminder. */
  readonly watcher_user_ids?: readonly number[]
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
}

/** A Service Reminder */
export interface FleetioServiceReminderWriteResult {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** Indicates whether the Service Reminder is currently active. */
  readonly active: boolean
  readonly vehicle_id: number
  readonly service_task_id: number | null
  /** The name of the `Service Task` associated with the Service Reminder, if applicable. */
  readonly service_task_name: string | null
  /** The number of time units according to `time_frequency` between each occurrence of the Service Reminder. */
  readonly time_interval: number | null
  readonly time_frequency: FleetioFrequency | null
  /** The date and time when the Service Reminder is next due. */
  readonly next_due_at: string | null
  /** The date and time when the Service Reminder will be considered due soon. */
  readonly due_soon_at: string | null
  /** The number of time units according to `due_soon_time_threshold_frequency` between `due_soon_at` occurrences. */
  readonly due_soon_time_threshold_interval: number | null
  readonly due_soon_time_threshold_frequency: FleetioFrequency | null
  /** The date and time at which the vehicle associated with the Service Reminder was archived, if applicable. */
  readonly vehicle_archived_at: string | null
  /** The forecasted date and time for the next due service. */
  readonly forecasted_next_due_at: string | null
  /** The forecasted date and time for the Service Reminder to be due soon. */
  readonly forecasted_due_soon_at: string | null
  /** The number of `Comments` on the Service Reminder. */
  readonly comments_count: number
  /** Indicates whether the Service Reminder has a starting interval. */
  readonly starting_interval: boolean | null
  /** The starting meter interval for this Service Reminder. */
  readonly starting_meter_interval: string | null
  /** The starting secondary meter interval for this Service Reminder. */
  readonly starting_secondary_meter_interval: string | null
  /** The starting time interval according to `starting_time_frequency` for time-based Service Reminders, if applicable. */
  readonly starting_time_interval: number | null
  readonly starting_time_frequency: FleetioFrequency | null
  /** The date and time until which the Service Reminder is snoozed. */
  readonly snooze_until: string | null
  /** The name of the Service Reminder status, if applicable. */
  readonly service_reminder_status_name: string | null
  /** Indicates whether the Service Reminder is associated with a secondary meter. */
  readonly secondary_meter: boolean
  /** The meter interval of which this Service Reminder takes place. */
  readonly meter_interval: string | null
  /** The meter value at which the Service Reminder is next due, if applicable. */
  readonly next_due_meter_value: string | null
  /** The meter value at which the Service Reminder is due soon, if applicable. */
  readonly due_soon_meter_value: string | null
  /** The meter value threshold to which this Service Reminder will be due soon. */
  readonly due_soon_meter_threshold: string | null
  /** The remaining meter units until the Service Reminder is due. */
  readonly meter_remaining_until_due: number | null
  /** The remaining secondary meter interval until the Service Reminder is due. */
  readonly secondary_meter_remaining_until_due: number | null
  /** The forecasted date and time for the primary Service Reminder to be due soon. */
  readonly forecasted_primary_due_soon_at: string | null
  /** The forecasted date and time for the next primary due Service Reminder. */
  readonly forecasted_primary_next_due_at: string | null
  /** The forecasted date and time for the secondary Service Reminder to be due soon. */
  readonly forecasted_secondary_due_soon_at: string | null
  /** The forecasted date and time for the next secondary due Service Reminder. */
  readonly forecasted_secondary_next_due_at: string | null
  /** A list of `Users` associated with the Service Reminder. */
  readonly users: readonly { readonly id?: number; readonly name?: string | null }[]
  /** The name of the `Vehicle` associated with the Service Reminder. */
  readonly vehicle_name: string
  /** The default image URL for the associated vehicle, if available. */
  readonly vehicle_default_image_url: string | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** A Service Entry */
  readonly latest_occurrence: FleetioServiceEntry | null
  readonly service_program_line_item: FleetioServiceProgramLineItem | null
  readonly comments: readonly FleetioComment[]
  /** The count of watchers associated with the record. */
  readonly watchers_count: number
  /** Indicates whether the record is being watched. */
  readonly is_watched: boolean
}

export type FleetioServiceReminderUpdateInput = Partial<FleetioServiceReminderCreateInput>
