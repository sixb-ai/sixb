import type { CtmPageOptions } from "./common"

export interface CtmContactList {
  /** `CL…`. */
  readonly id: string
  readonly account_id: number
  readonly name: string
  readonly description: string | null
  readonly contacts_count: number
  readonly created_at: string
  readonly updated_at: string
}

/** The object types the lookup API searches. Others exist; any string is passed through. */
export type CtmLookupObjectType =
  | "account"
  | "agent"
  | "call"
  | "call_queue"
  | "call_setting"
  | "conditional_router"
  | "contact"
  | "contact_number"
  | "custom_field"
  | "form_reactor"
  | "geo_config"
  | "receiving_number"
  | "schedule"
  | "tag"
  | "target_number"
  | "tracking_number"
  | "tracking_source"
  | "user"
  | "voice_menu"
  | "webhook"
  | (string & {})

export interface CtmLookupOptions extends CtmPageOptions {
  /** Matches the objects' text. */
  readonly search?: string
}

export interface CtmLookupResult {
  readonly id: string | number
  /** The object's display text, such as a tag's name. */
  readonly text: string
  readonly [field: string]: unknown
}
