import type {
  PandaDocDocumentStatus,
  PandaDocDocumentStatusCode,
  PandaDocJsonObject,
  PandaDocPageOptions,
  QueryValue,
} from "./common"

export interface PandaDocDocumentListOptions extends PandaDocPageOptions {
  readonly template_id?: string
  readonly form_id?: string
  readonly folder_uuid?: string
  readonly contact_id?: string
  readonly order_by?:
    | "date_created"
    | "-date_created"
    | "date_status_changed"
    | "-date_status_changed"
    | "date_modified"
    | "-date_modified"
    | (string & {})
  readonly created_from?: string
  readonly created_to?: string
  readonly completed_from?: string
  readonly completed_to?: string
  readonly modified_from?: string
  readonly modified_to?: string
  readonly deleted?: boolean
  readonly id?: string
  readonly membership_id?: string
  readonly metadata?: readonly string[]
  readonly q?: string
  readonly status?: PandaDocDocumentStatusCode | PandaDocDocumentStatus
  readonly status__ne?: PandaDocDocumentStatusCode | PandaDocDocumentStatus
  readonly tag?: string
}

export interface PandaDocDocumentSummary extends PandaDocJsonObject {
  readonly id: string
  readonly name?: string
  readonly status?: PandaDocDocumentStatus
  readonly date_created?: string
  readonly date_modified?: string
}

export interface PandaDocDocumentDetails extends PandaDocJsonObject {
  readonly id: string
  readonly name?: string
  readonly status?: PandaDocDocumentStatus
  readonly recipients?: readonly PandaDocJsonObject[]
  readonly fields?: readonly PandaDocJsonObject[] | PandaDocJsonObject
  readonly tokens?: readonly PandaDocJsonObject[] | PandaDocJsonObject
  readonly pricing?: PandaDocJsonObject
  readonly metadata?: PandaDocJsonObject
}

export interface PandaDocDocumentCreateInput extends PandaDocJsonObject {
  readonly name: string
  readonly template_uuid?: string
  readonly url?: string
  readonly folder_uuid?: string
  readonly owner?: PandaDocJsonObject
  readonly recipients?: readonly PandaDocRecipientInput[]
  readonly tokens?: readonly PandaDocTokenInput[]
  readonly fields?: PandaDocJsonObject
  readonly metadata?: PandaDocJsonObject
  readonly tags?: readonly string[]
}

export interface PandaDocDocumentCreateOptions {
  readonly editor_ver?: string
  readonly use_form_field_properties?: string | boolean
}

export interface PandaDocDocumentCreateResponse extends PandaDocDocumentSummary {
  readonly links?: readonly PandaDocJsonObject[]
  readonly info_message?: string
}

export interface PandaDocRecipientInput extends PandaDocJsonObject {
  readonly email?: string
  readonly first_name?: string
  readonly last_name?: string
  readonly role?: string
  readonly phone?: string
  readonly signing_order?: number
}

export interface PandaDocTokenInput extends PandaDocJsonObject {
  readonly name: string
  readonly value: string | number | boolean
}

export interface PandaDocDocumentSendInput extends PandaDocJsonObject {
  readonly subject?: string
  readonly message?: string
  readonly silent?: boolean
  readonly forwarding_settings?: PandaDocJsonObject
  readonly selected_approvers?: readonly PandaDocJsonObject[]
}

export interface PandaDocDocumentStatusChangeInput extends PandaDocJsonObject {
  readonly status: 2 | 10 | 11 | 12 | number
  readonly note?: string
  readonly notify_recipients?: boolean
}

export interface PandaDocDocumentSessionInput extends PandaDocJsonObject {
  readonly recipient: string
  readonly lifetime?: number
}

export interface PandaDocDocumentEditingSessionInput extends PandaDocJsonObject {
  readonly recipient?: string
  readonly lifetime?: number
}

export interface PandaDocDocumentDownloadOptions {
  readonly [key: string]: string | number | boolean | undefined
  readonly watermark_color?: string
  readonly watermark_font_size?: number
  readonly separate_files?: boolean
}

export interface PandaDocLinkedObjectListOptions {
  readonly [key: string]: QueryValue
  readonly provider: string
  readonly entity_type: string
  readonly entity_id: string
  readonly order_by?: string
  readonly owner_ids?: readonly string[]
}

export interface PandaDocLinkedObjectInput extends PandaDocJsonObject {
  readonly provider: string
  readonly entity_type: string
  readonly entity_id: string
}
