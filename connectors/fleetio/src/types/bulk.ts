import type { FleetioFaultCreateInput } from "./faults"
import type { FleetioGroupUpdateInput } from "./groups"
import type { FleetioInventoryJournalEntryCreateInput } from "./inventory"
import type { FleetioMeterEntryCreateInput } from "./meter-entries"
import type { FleetioVehicleCreateInput, FleetioVehicleUpdateInput } from "./vehicles"

/** A record to update in a bulk job, found by the field and value named on it. */
export type FleetioBulkUpdateRecord<TInput> = TInput & {
  /** The field that identifies the record, such as `id` or `vin`. */
  readonly identifier_field_name: string
  readonly identifier_field_value: string | number
}

/** The resources and operations Fleetio's Bulk API accepts. It cannot delete in bulk. */
export type FleetioBulkJobInput =
  | {
      readonly resource: "fault"
      readonly operation: "create"
      readonly records: readonly FleetioFaultCreateInput[]
    }
  | {
      readonly resource: "group"
      readonly operation: "update"
      readonly records: readonly FleetioBulkUpdateRecord<FleetioGroupUpdateInput>[]
    }
  | {
      /** Only on accounts using the static pricing model. */
      readonly resource: "inventory_journal_entry"
      readonly operation: "create"
      readonly records: readonly FleetioInventoryJournalEntryCreateInput[]
    }
  | {
      readonly resource: "location_entry"
      readonly operation: "create"
      readonly records: readonly Readonly<Record<string, unknown>>[]
    }
  | {
      readonly resource: "meter_entry"
      readonly operation: "create"
      readonly records: readonly FleetioMeterEntryCreateInput[]
    }
  | {
      readonly resource: "vehicle"
      readonly operation: "create"
      readonly records: readonly FleetioVehicleCreateInput[]
    }
  | {
      readonly resource: "vehicle"
      readonly operation: "update"
      readonly records: readonly FleetioBulkUpdateRecord<FleetioVehicleUpdateInput>[]
    }

export interface FleetioBulkJobFailedRecord {
  /** The record's position in the submitted `records`. */
  readonly index: number
  readonly error_messages: readonly string[]
}

export interface FleetioBulkJobSuccessfulRecord {
  /** The record's position in the submitted `records`. */
  readonly index: number
  readonly id: number
}

/** A bulk job. Fleetio sends no notice on completion, so poll until `state` is `complete`. */
export interface FleetioBulkJob {
  readonly id: number
  readonly state: "pending" | "complete" | (string & {})
  readonly started_at: string | null
  readonly total_count: number
  readonly completed_count?: number
  readonly failed_count?: number
  readonly failed_records?: readonly FleetioBulkJobFailedRecord[]
  readonly successful_records?: readonly FleetioBulkJobSuccessfulRecord[]
  /** Present while the job is pending. */
  readonly successful_record_ids?: readonly number[]
}
