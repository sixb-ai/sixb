import type { FleetioComment } from "./comments"
import type { FleetioEqFilter, FleetioRangeFilter, FleetioSortDirection } from "./common"
import type {
  FleetioAttachmentPermissions,
  FleetioCommentsAttributes,
  FleetioContactMini,
  FleetioVehicleMini,
} from "./shared"

/** A Vehicle Assignment */
export interface FleetioVehicleAssignment {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly vehicle_id: number
  readonly contact_id: number
  /** The date and time of this Vehicle Assignment. */
  readonly started_at: string | null
  /** The date and time of this Vehicle Assignment ending. */
  readonly ended_at: string | null
  /** Whether this Vehicle Assignment is current/active. */
  readonly current: boolean
  /** Whether this Vehicle Assignment is set to take place in the future. */
  readonly future: boolean
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  /** The meter value at the start of this Vehicle Assignment. */
  readonly starting_meter_entry_value: string | null
  /** The meter value at the end of this Vehicle Assignment. */
  readonly ending_meter_entry_value: string | null
  /** The number of comments on this Vehicle Assignment. */
  readonly comments_count: number
  readonly contact_full_name?: string | null
  /** The URL pointing to the `Contact`'s image. */
  readonly contact_image_url?: string | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** Any `Comments` made on this Vehicle Assignment. */
  readonly comments: readonly FleetioComment[]
}

/** A Vehicle Assignment */
export interface FleetioVehicleAssignmentSummary {
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
  readonly id: number
  /** The id of the vehicle associated with this Vehicle Assignment. */
  readonly vehicle_id: number
  /** The id of the contact associated with this Vehicle Assignment. */
  readonly contact_id: number
  /** The date and time of this Vehicle Assignment. */
  readonly started_at: string | null
  /** The date and time of this Vehicle Assignment ending. */
  readonly ended_at: string | null
  /** Whether this Vehicle Assignment is current/active. */
  readonly current: boolean
  /** Whether this Vehicle Assignment is set to take place in the future. */
  readonly future: boolean
  /** The meter value at the start of this Vehicle Assignment. */
  readonly starting_meter_entry_value: number | null
  /** The meter value at the end of this Vehicle Assignment. */
  readonly ending_meter_entry_value: number | null
  /** The number of comments on this Vehicle Assignment. */
  readonly comments_count: number
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** A Contact */
  readonly contact: FleetioContactMini | null
  /** A Vehicle */
  readonly vehicle: FleetioVehicleMini
}

export interface FleetioVehicleAssignmentFilter {
  readonly contact_id?: FleetioEqFilter
  readonly vehicle_id?: FleetioEqFilter
  readonly ended_at?: FleetioRangeFilter
  readonly started_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVehicleAssignmentSort {
  readonly started_at?: FleetioSortDirection
  readonly ended_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioVehicleAssignmentCreateInput {
  /** If the `Contact` being assigned has an employee number, it can be included here. */
  readonly contact_employee_number?: string
  readonly contact_id: number
  readonly vehicle_id: number
  /** The date and time of this Vehicle Assignment. */
  readonly started_at?: string
  /** The date and time of this Vehicle Assignment ending. */
  readonly ended_at?: string
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A Vehicle Assignment may be associated with a starting Meter Entry */
  readonly starting_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  /** A Vehicle Assignment may also be associated with an ending Meter Entry */
  readonly ending_meter_entry_attributes?: { readonly value?: number; readonly void?: boolean }
  readonly comments_attributes?: readonly FleetioCommentsAttributes[]
}

export type FleetioVehicleAssignmentUpdateInput = Partial<FleetioVehicleAssignmentCreateInput>
