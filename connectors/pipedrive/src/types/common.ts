import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { Logger, OntologySource, Sixb } from "@sixb/core"
import type { PipedriveClient } from "./client"

export type PipedriveTokenResolver = string | (() => string | Promise<string>)

export interface PipedriveWebhookBasicAuth {
  readonly username: string
  readonly password: string
}

export interface PipedriveConnectorOptions {
  readonly apiToken: PipedriveTokenResolver
  /** API v2 base URL. Defaults to https://api.pipedrive.com/api/v2/. */
  readonly v2BaseUrl?: string
  /** API v1 base URL. Defaults to https://api.pipedrive.com/v1/. */
  readonly v1BaseUrl?: string
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
  /** Basic-auth credentials used to verify inbound webhook deliveries. */
  readonly webhookAuth?: PipedriveWebhookBasicAuth
  /**
   * Register the inbound webhook even though it cannot be verified.
   *
   * Without `webhookAuth` the route accepts unverified requests from anyone who can
   * reach it, so the connector refuses to build it unless this says otherwise.
   */
  readonly webhookAllowUnverified?: boolean
  readonly onEvent?: PipedriveEventHandler
}

export type PipedriveJsonValue =
  | string
  | number
  | boolean
  | null
  | PipedriveJsonObject
  | readonly PipedriveJsonValue[]

export interface PipedriveJsonObject {
  readonly [key: string]: PipedriveJsonValue | undefined
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

export interface PipedriveResponse<TData, TAdditional = PipedriveAdditionalData> {
  readonly success: boolean
  readonly data: TData
  readonly additional_data?: TAdditional
  readonly related_objects?: PipedriveJsonObject
}

export interface PipedriveAdditionalData extends PipedriveJsonObject {
  readonly next_cursor?: string | null
  readonly pagination?: PipedriveOffsetPagination
}

export interface PipedriveCursorPage<TItem> {
  readonly success: boolean
  readonly data: readonly TItem[]
  readonly additional_data?: {
    readonly next_cursor?: string | null
  }
}

export interface PipedriveOffsetPage<TItem> {
  readonly success: boolean
  readonly data: readonly TItem[]
  readonly additional_data?: {
    readonly pagination?: PipedriveOffsetPagination
  }
}

export interface PipedriveOffsetPagination extends PipedriveJsonObject {
  readonly start?: number
  readonly limit?: number
  readonly more_items_in_collection?: boolean
  readonly next_start?: number
}

export interface PipedriveCursorOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface PipedriveOffsetOptions {
  readonly start?: number
  readonly limit?: number
}

export type PipedriveSortDirection = "asc" | "desc"

export interface PipedriveWebhookMeta extends PipedriveJsonObject {
  readonly action?: "create" | "change" | "delete" | string
  readonly entity?: string
  readonly company_id?: string
  readonly correlation_id?: string
  readonly entity_id?: string
  readonly id?: string
  readonly is_bulk_edit?: boolean
  readonly timestamp?: string
  readonly type?: string
  readonly user_id?: string
  readonly version?: string
  readonly webhook_id?: string
  readonly webhook_owner_id?: string
  readonly change_source?: string
  readonly attempt?: number
  readonly host?: string
  readonly permitted_user_ids?: readonly string[]
}

export interface PipedriveWebhookEvent {
  readonly meta: PipedriveWebhookMeta
  readonly data?: PipedriveJsonValue
  readonly previous?: PipedriveJsonValue
}

export interface PipedriveEventContext {
  readonly event: PipedriveWebhookEvent
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logger: Logger
  client(): Promise<PipedriveClient>
}

export type PipedriveEventHandler = (context: PipedriveEventContext) => Promise<void> | void
