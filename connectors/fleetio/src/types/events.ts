import type { Logger, Sixb } from "@sixb/core"
import type { FleetioClient } from "./client"

/**
 * Event names from Fleetio's docs and API spec. The two disagree on a few names, so both spellings
 * are listed. Fleetio adds new events without a version change, so any other string can arrive too.
 */
export type FleetioEventName =
  | "contact_archived"
  | "contact_assigned"
  | "contact_comment_added"
  | "contact_created"
  | "contact_deleted"
  | "contact_merged"
  | "contact_updated"
  | "dtc_alert_created"
  | "dtc_alert_resolved"
  | "equipment_comment_added"
  | "equipment_created"
  | "equipment_deleted"
  | "equipment_updated"
  | "expense_entry_comment_added"
  | "expense_entry_created"
  | "expense_entry_deleted"
  | "expense_entry_updated"
  | "fault_created"
  | "fault_resolved"
  | "fuel_entry_comment_added"
  | "fuel_entry_created"
  | "fuel_entry_deleted"
  | "fuel_entry_updated"
  | "import_completed"
  | "issue_closed"
  | "issue_comment_added"
  | "issue_created"
  | "issue_deleted"
  | "issue_resolved"
  | "issue_updated"
  | "location_entry_created"
  | "location_entry_delete"
  | "location_entry_deleted"
  | "location_entry_updated"
  | "meter_entry_created"
  | "meter_entry_deleted"
  | "meter_entry_updated"
  | "part_comment_added"
  | "part_created"
  | "part_deleted"
  | "part_updated"
  | "place_created"
  | "place_deleted"
  | "place_updated"
  | "place_visited"
  | "purchase_order_approved"
  | "purchase_order_closed"
  | "purchase_order_comment_added"
  | "purchase_order_created"
  | "purchase_order_deleted"
  | "purchase_order_pending_approval"
  | "purchase_order_purchased"
  | "purchase_order_received"
  | "purchase_order_updated"
  | "service_entry_comment_added"
  | "service_entry_created"
  | "service_entry_deleted"
  | "service_entry_updated"
  | "submitted_inspection_form_created"
  | "submitted_inspection_form_deleted"
  | "user_archived"
  | "user_created"
  | "user_updated"
  | "vehicle_archived"
  | "vehicle_assigned"
  | "vehicle_assignment_created"
  | "vehicle_assignment_deleted"
  | "vehicle_assignment_updated"
  | "vehicle_comment_added"
  | "vehicle_created"
  | "vehicle_deleted"
  | "vehicle_group_changed"
  | "vehicle_status_changed"
  | "vehicle_updated"
  | "vendor_comment_added"
  | "vendor_created"
  | "vendor_deleted"
  | "vendor_updated"
  | "work_order_comment_added"
  | "work_order_created"
  | "work_order_deleted"
  | "work_order_document_added"
  | "work_order_status_changed"
  | "work_order_updated"
  | (string & {})

/** One inbound webhook delivery from Fleetio. */
export interface FleetioEvent {
  /** The delivery's ID, separate from the record's own `payload.id`. */
  readonly id: number
  readonly type: FleetioEventName
  /** ISO 8601, in the account's time zone. */
  readonly timestamp: string
  /** The user who caused the event, or `null`. */
  readonly triggeredBy: string | null
  /** The record that triggered the event. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** Context passed to the connector's `onEvent` handler for each inbound webhook delivery. */
export interface FleetioEventContext {
  readonly event: FleetioEvent
  readonly request: Request
  readonly sixb: Sixb
  readonly logger: Logger
  /** Resolves the Fleetio client lazily, only if the handler needs to read back. */
  client(): Promise<FleetioClient>
}

export type FleetioEventHandler = (context: FleetioEventContext) => Promise<void> | void
