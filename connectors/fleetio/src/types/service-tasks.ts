import type {
  FleetioEqFilter,
  FleetioLikeFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioVmrsReasonForRepairCode, FleetioVmrsSystemCode } from "./shared"

export interface FleetioServiceTaskSubtask {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of this subtask. */
  readonly name?: string
  /** A description of this subtask. */
  readonly description?: string | null
  /** The expected duration in seconds this subtask should take to complete. */
  readonly expected_duration_in_seconds?: number | null
  /** The subtasks array at this level will always be empty. */
  readonly subtasks?: readonly unknown[]
  readonly default_vmrs_reason_for_repair?: FleetioVmrsReasonForRepairCode | null
  readonly default_vmrs_system_group?: FleetioVmrsSystemCode | null
  readonly default_vmrs_system?: FleetioVmrsSystemCode | null
  readonly default_vmrs_assembly?: FleetioVmrsSystemCode | null
  readonly default_vmrs_component?: FleetioVmrsSystemCode | null
}

export interface FleetioServiceTaskServiceTaskPart {
  readonly id?: number
  /** The quantity of this `Part` related to the Service Task. */
  readonly quantity?: number
  /** The ID of this `Part` related to the Service Task. */
  readonly part_id?: number
  /** The date and time at which the `Part` related to the Service Task was archived, if applicable. */
  readonly part_archived_at?: string | null
  /** The position of this `Part` in the list of Service Task Parts. */
  readonly position?: number
}

/** A Service Task */
export interface FleetioServiceTask {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** A name for this Service Task. */
  readonly name: string
  /** A description of this Service Task. */
  readonly description: string | null
  /** The expected duration in seconds this Service Task should take to complete. */
  readonly expected_duration_in_seconds?: number | null
  /** The date and time at which this Service Task was archived. */
  readonly archived_at?: string | null
  readonly subtasks: readonly FleetioServiceTaskSubtask[]
  /** Indicates the number of times this Service Task has been used. */
  readonly usage?: number
  readonly default_vmrs_reason_for_repair: FleetioVmrsReasonForRepairCode | null
  readonly default_vmrs_system_group: FleetioVmrsSystemCode | null
  readonly default_vmrs_system: FleetioVmrsSystemCode | null
  readonly default_vmrs_assembly: FleetioVmrsSystemCode | null
  readonly default_vmrs_component: FleetioVmrsSystemCode | null
  /** Any `Parts` associated with this Service Task. */
  readonly service_task_parts?: readonly FleetioServiceTaskServiceTaskPart[]
}

/** A Service Task Category */
export interface FleetioServiceTaskCategoryMini {
  readonly id: number
  /** The name of this Service Task Category. */
  readonly name: string
  /** A description for this Service Task Category. */
  readonly description: string | null
  /** The ID of the parent Service Task Category. */
  readonly parent_category_id?: number | null
  /** Whether or not this Service Task Category is standard. */
  readonly standard: boolean
}

/** A Service Task */
export interface FleetioServiceTaskSummary {
  readonly id: number
  readonly created_at: string
  readonly updated_at: string
  /** The date and time at which this Service Task was archived. */
  readonly archived_at?: string | null
  /** A name for this Service Task. */
  readonly name: string
  /** A description of this Service Task. */
  readonly description: string | null
  /** The expected duration in seconds this Service Task should take to complete. */
  readonly expected_duration_in_seconds?: number | null
  /** The ID of the VMRS assembly associated with this Service Task. */
  readonly default_vmrs_assembly_id?: number | null
  /** The ID of the VMRS component associated with this Service Task. */
  readonly default_vmrs_component_id?: number | null
  /** The ID of the VMRS reason for repair associated with this Service Task. */
  readonly default_vmrs_reason_for_repair_id?: number | null
  /** The ID of the VMRS system group associated with this Service Task. */
  readonly default_vmrs_system_group_id?: number | null
  /** The ID of the VMRS system associated with this Service Task. */
  readonly default_vmrs_system_id?: number | null
  /** The ID of the Service Task Category associated with this Service Task. */
  readonly service_task_category_id?: number | null
  /** The ID of the Standard Service Task associated with this Service Task. */
  readonly standard_service_task_id?: number | null
  /** The ID of the Merged Service Task associated with this Service Task. */
  readonly merged_service_task_id?: number | null
  /** Whether or not this Service Task is a Standard Service Task. */
  readonly standard: boolean
  /** Whether or not this Service Task is a group. */
  readonly is_group: boolean
  /** A Service Task Category */
  readonly service_task_category?: FleetioServiceTaskCategoryMini | null
}

export interface FleetioServiceTaskFilter {
  readonly name?: FleetioLikeFilter
  readonly default_vmrs_assembly_id?: FleetioEqFilter
  readonly default_vmrs_component_id?: FleetioEqFilter
  readonly default_vmrs_reason_for_repair_id?: FleetioEqFilter
  readonly default_vmrs_system_group_id?: FleetioEqFilter
  readonly default_vmrs_system_id?: FleetioEqFilter
  readonly service_task_category_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioServiceTaskSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioServiceTaskCreateInput {
  /** The name of the Service Task. */
  readonly name: string
  /** A description of the Service Task. */
  readonly description?: string | null
}

/** A Service Task */
export interface FleetioServiceTaskCreated {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** The date and time this Service Task was archived, if applicable. */
  readonly archived_at?: string | null
  /** A name for this Service Task. */
  readonly name: string
  /** A description of this Service Task. */
  readonly description: string | null
  /** Whether this Service Task belongs to a group of Service Tasks. */
  readonly is_group?: boolean
  /** The expected duration in seconds this Service Task should take to complete. */
  readonly expected_duration_in_seconds?: number | null
  /** Whether this Service Task is a standard (commonly performed) Service Task. */
  readonly standard?: boolean
  /** The category hierarchy of this Service Task. */
  readonly category_hierarchy?: string
  /** The ID of the Service Task Category this Service Task belongs to. */
  readonly service_task_category_id?: number | null
  /** The ID of the Standard Service Task this Service Task belongs to. */
  readonly standard_service_task_id?: number | null
  /** The ID of the default VMRS Reason for Repair for this Service Task. */
  readonly default_vmrs_reason_for_repair_id?: number | null
  /** The ID of the default VMRS System for this Service Task. */
  readonly default_vmrs_system_id?: number | null
  /** The ID of the default VMRS Assembly for this Service Task. */
  readonly default_vmrs_assembly_id?: number | null
  /** The ID of the default VMRS Component for this Service Task. */
  readonly default_vmrs_component_id?: number | null
  /** The ID of the default VMRS System Group for this Service Task. */
  readonly default_vmrs_system_group_id?: number | null
  /** If this Service Task has been merged, this is the ID of the Service Task it was merged into. */
  readonly merged_service_task_id?: number | null
}

export type FleetioServiceTaskUpdateInput = Partial<FleetioServiceTaskCreateInput>
