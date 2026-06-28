import type { PandaDocItemsResponse, PandaDocJsonObject, PandaDocPageOptions } from "./common"

export interface PandaDocBulkDeleteDocumentInput extends PandaDocJsonObject {
  readonly id: string
}

export interface PandaDocBulkDeleteDocumentsResponse extends PandaDocJsonObject {
  readonly id?: readonly string[]
}

export interface PandaDocAutoReminderSettings extends PandaDocJsonObject {}

export interface PandaDocAutoReminderStatus extends PandaDocJsonObject {}

export interface PandaDocESignDisclosure extends PandaDocJsonObject {}

export interface PandaDocDocumentAttachment extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly name?: string
}

export interface PandaDocDocumentAttachmentInput extends PandaDocJsonObject {}

export interface PandaDocDocumentSection extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly name?: string
}

export interface PandaDocDocumentSectionUpload extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly status?: string
}

export interface PandaDocAuditTrailItem extends PandaDocJsonObject {}

export type PandaDocAuditTrailResponse = PandaDocItemsResponse<PandaDocAuditTrailItem>

export interface PandaDocDocumentSettings extends PandaDocJsonObject {}

export interface PandaDocDocumentOwnershipInput extends PandaDocJsonObject {
  readonly membership_id?: string
  readonly owner_id?: string
}

export interface PandaDocManualReminderInput extends PandaDocJsonObject {
  readonly subject?: string
  readonly message?: string
}

export type PandaDocSectionsListOptions = PandaDocPageOptions
