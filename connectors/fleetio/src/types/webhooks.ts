import type {
  FleetioEqFilter,
  FleetioIncludeFilter,
  FleetioLikeFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"

/** A Webhook */
export interface FleetioWebhook {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly account_id: number
  /** Indicates whether or not this Webhook should be triggered by all events. */
  readonly all_events?: boolean
  /** The authorization header to include in the request to the URL specified by `url`. */
  readonly authorization?: string | null
  /** A description of this Webhook. */
  readonly description?: string | null
  /** The date and time at which the Webhook was disabled. */
  readonly disabled_at?: string | null
  /** The reason this Webhook was disabled. */
  readonly disabled_reason?: string | null
  /** Indicates whether or not this Webhook is enabled. */
  readonly enabled?: boolean
  /** The number of instances of this Webhook that have failed to be handled by the endpoint (after retries have been exhausted). */
  readonly failed_attempts?: number
  /** The shared key to verify that incoming messages came from Fleetio. */
  readonly shared_key?: string
  /** The events that this Webhook is subscribed to. */
  readonly subscribed_events?: Readonly<Record<string, boolean>>
  /** The URL to which this Webhook will send a POST request when triggered. */
  readonly url: string
}

export interface FleetioWebhookFilter {
  readonly url?: FleetioLikeFilter
  readonly description?: FleetioLikeFilter
  readonly enabled?: FleetioEqFilter
  readonly created_by_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioWebhookSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioWebhookCreateInput {
  readonly all_events?: boolean
  /** If the URL requires authentication, the value provided here gets passed as the HTTP 'Authorization' header */
  readonly authorization?: string
  readonly contact_archived?: boolean
  readonly contact_assigned?: boolean
  readonly contact_comment_added?: boolean
  readonly contact_created?: boolean
  readonly contact_deleted?: boolean
  readonly contact_merged?: boolean
  readonly contact_updated?: boolean
  readonly description?: string
  readonly enabled?: boolean
  readonly equipment_comment_added?: boolean
  readonly equipment_created?: boolean
  readonly equipment_deleted?: boolean
  readonly equipment_updated?: boolean
  readonly expense_entry_comment_added?: boolean
  readonly expense_entry_created?: boolean
  readonly expense_entry_deleted?: boolean
  readonly expense_entry_updated?: boolean
  readonly fault_created?: boolean
  readonly fault_resolved?: boolean
  readonly fuel_entry_comment_added?: boolean
  readonly fuel_entry_created?: boolean
  readonly fuel_entry_deleted?: boolean
  readonly fuel_entry_updated?: boolean
  readonly import_completed?: boolean
  readonly issue_closed?: boolean
  readonly issue_comment_added?: boolean
  readonly issue_created?: boolean
  readonly issue_deleted?: boolean
  readonly issue_resolved?: boolean
  readonly issue_updated?: boolean
  readonly location_entry_created?: boolean
  readonly location_entry_deleted?: boolean
  readonly location_entry_updated?: boolean
  readonly meter_entry_created?: boolean
  readonly meter_entry_deleted?: boolean
  readonly meter_entry_updated?: boolean
  readonly part_comment_added?: boolean
  readonly part_created?: boolean
  readonly part_deleted?: boolean
  readonly part_updated?: boolean
  readonly place_created?: boolean
  readonly place_deleted?: boolean
  readonly place_updated?: boolean
  readonly place_visited?: boolean
  readonly purchase_order_approved?: boolean
  readonly purchase_order_closed?: boolean
  readonly purchase_order_comment_added?: boolean
  readonly purchase_order_created?: boolean
  readonly purchase_order_deleted?: boolean
  readonly purchase_order_pending_approval?: boolean
  readonly purchase_order_purchased?: boolean
  readonly purchase_order_received?: boolean
  readonly purchase_order_updated?: boolean
  readonly service_entry_comment_added?: boolean
  readonly service_entry_created?: boolean
  readonly service_entry_deleted?: boolean
  readonly service_entry_updated?: boolean
  readonly submitted_inspection_form_created?: boolean
  readonly submitted_inspection_form_deleted?: boolean
  /** *Must begin with http:// or https:// */
  readonly url: string
  readonly user_created?: boolean
  readonly user_updated?: boolean
  readonly user_archived?: boolean
  readonly vehicle_archived?: boolean
  readonly vehicle_assigned?: boolean
  readonly vehicle_assignment_created?: boolean
  readonly vehicle_assignment_deleted?: boolean
  readonly vehicle_assignment_updated?: boolean
  readonly vehicle_comment_added?: boolean
  readonly vehicle_created?: boolean
  readonly vehicle_deleted?: boolean
  readonly vehicle_group_changed?: boolean
  readonly vehicle_status_changed?: boolean
  readonly vehicle_updated?: boolean
  readonly vendor_comment_added?: boolean
  readonly vendor_created?: boolean
  readonly vendor_deleted?: boolean
  readonly vendor_updated?: boolean
  readonly work_order_comment_added?: boolean
  readonly work_order_created?: boolean
  readonly work_order_deleted?: boolean
  readonly work_order_document_added?: boolean
  readonly work_order_status_changed?: boolean
  readonly work_order_updated?: boolean
}

export type FleetioWebhookUpdateInput = Partial<FleetioWebhookCreateInput>

/** A Webhook Event */
export interface FleetioWebhookEvent {
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The number of times Fleetio attempted to send this event to the Webhook endpoint. */
  readonly attempts?: number
  /** The event that triggered this Webhook. */
  readonly event?: string
  /** The last error that occurred when attempting to trigger this Webhook. */
  readonly last_error?: string | null
  /** The date and time at which this webhook event was last sent. */
  readonly last_sent_at?: string | null
  /** The payload that was sent to the Webhook endpoint. */
  readonly payload?: string
  /** The response body from the Webhook endpoint. */
  readonly response_body?: string | null
  /** The response code from the Webhook endpoint. */
  readonly response_code?: number | null
  /** The date and time at which this Webhook was last retried. */
  readonly retried_at?: string | null
  /** The status of this Webhook event. */
  readonly status?: string | null
  readonly webhook_id?: number
}

export interface FleetioWebhookEventFilter {
  readonly status?: FleetioIncludeFilter
  readonly event?: FleetioLikeOrEqFilter
  readonly webhook_id?: FleetioEqFilter
  readonly last_sent_at?: FleetioRangeFilter
  readonly retried_at?: FleetioRangeFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioWebhookEventSort {
  readonly id?: FleetioSortDirection
  readonly retried_at?: FleetioSortDirection
  readonly last_sent_at?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}
