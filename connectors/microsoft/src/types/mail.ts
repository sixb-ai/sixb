import type { GraphPage, ListOptions, RequestOptions, SelectOptions } from "./common"

export interface MailRecipient {
  readonly emailAddress: { readonly address?: string | null; readonly name?: string | null }
}
export interface MailBody {
  readonly contentType: "text" | "html"
  readonly content: string
}
export interface MailDateTime {
  readonly dateTime: string
  readonly timeZone: string
}
export interface MailFlag {
  readonly flagStatus: "notFlagged" | "complete" | "flagged"
  readonly startDateTime?: MailDateTime | null
  readonly dueDateTime?: MailDateTime | null
  readonly completedDateTime?: MailDateTime | null
}
export interface MailHeader {
  readonly name: string
  readonly value: string
}
/** Wire properties can be absent in projections and delta responses. */
export interface MailMessage {
  readonly id: string
  readonly subject?: string | null
  readonly body?: MailBody | null
  readonly uniqueBody?: MailBody | null
  readonly bodyPreview?: string | null
  readonly from?: MailRecipient | null
  readonly sender?: MailRecipient | null
  readonly toRecipients?: readonly MailRecipient[] | null
  readonly ccRecipients?: readonly MailRecipient[] | null
  readonly bccRecipients?: readonly MailRecipient[] | null
  readonly replyTo?: readonly MailRecipient[] | null
  readonly isDraft?: boolean | null
  readonly isRead?: boolean | null
  readonly importance?: "low" | "normal" | "high" | null
  readonly categories?: readonly string[] | null
  readonly flag?: MailFlag | null
  readonly hasAttachments?: boolean | null
  readonly parentFolderId?: string | null
  readonly conversationId?: string | null
  readonly conversationIndex?: string | null
  readonly internetMessageId?: string | null
  readonly internetMessageHeaders?: readonly MailHeader[] | null
  readonly receivedDateTime?: string | null
  readonly sentDateTime?: string | null
  readonly createdDateTime?: string | null
  readonly lastModifiedDateTime?: string | null
  readonly changeKey?: string | null
  readonly webLink?: string | null
  readonly attachments?: readonly MailAttachment[] | null
}
export interface MailMessageUpdate {
  readonly isRead?: boolean
  readonly categories?: readonly string[]
  readonly flag?: MailFlag
  readonly importance?: "low" | "normal" | "high"
}
/** Subject, body and recipients can only be changed on a draft. Graph enforces isDraft. */
export interface MailDraftUpdate extends MailMessageUpdate {
  readonly subject?: string
  readonly body?: MailBody
  readonly toRecipients?: readonly MailRecipient[]
  readonly ccRecipients?: readonly MailRecipient[]
  readonly bccRecipients?: readonly MailRecipient[]
  readonly replyTo?: readonly MailRecipient[]
  readonly isDeliveryReceiptRequested?: boolean
  readonly isReadReceiptRequested?: boolean
}
export interface MailDraftInput extends MailDraftUpdate {
  /** Custom header names must start with x-. Only set when creating the message. */
  readonly internetMessageHeaders?: readonly MailHeader[]
}
/** Supply either a comment or message.body, never both. */
export type MailReplyInput =
  | { readonly comment?: string; readonly message?: Omit<MailDraftUpdate, "body"> }
  | { readonly comment?: never; readonly message: MailDraftUpdate }
export interface MailForwardInput {
  readonly comment?: string
  readonly toRecipients: readonly MailRecipient[]
}
export interface MailFolder {
  readonly id: string
  readonly displayName?: string | null
  readonly parentFolderId?: string | null
  readonly childFolderCount?: number | null
  readonly unreadItemCount?: number | null
  readonly totalItemCount?: number | null
  readonly isHidden?: boolean | null
}
export interface MailGetOptions extends SelectOptions {
  readonly bodyContentType?: "text" | "html"
}
export interface MailListOptions extends ListOptions {
  readonly filter?: string
  /** Graph search expression, including quotes where required by Graph. Not an exhaustive sync. */
  readonly search?: string
  readonly bodyContentType?: "text" | "html"
}
export interface MailFolderListOptions extends ListOptions {
  readonly includeHiddenFolders?: boolean
}
export interface MailSendOptions extends RequestOptions {
  readonly saveToSentItems?: boolean
}
export interface MailSendResult {
  /** Microsoft accepted the request; this does not establish delivery. */
  readonly status: "accepted"
  readonly requestId?: string
}
export interface MailDeltaOptions extends RequestOptions {
  /** Opaque checkpoint; persist together with its tenant, mailbox and folder. */
  readonly cursor?: string
  readonly select?: readonly string[]
  readonly pageSize?: number
}
export interface MailMessageDeltaOptions extends MailDeltaOptions {
  readonly top?: number
  readonly expand?: string
  readonly changeType?: "created" | "updated" | "deleted"
  readonly filter?: string
  readonly orderBy?: "receivedDateTime desc"
  readonly bodyContentType?: "text" | "html"
}
export type MailDeltaItem<T> = T & {
  /** For messages, removal can mean a move out of the folder, not deletion from the mailbox. */
  readonly "@removed"?: { readonly reason?: string }
}
export interface MailDeltaPage<T> extends GraphPage<MailDeltaItem<T>> {
  readonly "@odata.deltaLink"?: string
}
interface MailAttachmentBase {
  readonly id: string
  readonly name?: string | null
  readonly contentType?: string | null
  readonly size?: number | null
  readonly isInline?: boolean | null
  readonly lastModifiedDateTime?: string | null
}
export interface MailFileAttachment extends MailAttachmentBase {
  readonly "@odata.type": "#microsoft.graph.fileAttachment"
  readonly contentBytes?: string | null
  readonly contentId?: string | null
}
export interface MailItemAttachment extends MailAttachmentBase {
  readonly "@odata.type": "#microsoft.graph.itemAttachment"
  readonly item?: Readonly<Record<string, unknown>> | null
}
export interface MailReferenceAttachment extends MailAttachmentBase {
  readonly "@odata.type": "#microsoft.graph.referenceAttachment"
  readonly sourceUrl?: string | null
}
export type MailAttachment = MailFileAttachment | MailItemAttachment | MailReferenceAttachment
export interface MailFileOptions extends RequestOptions {
  readonly contentType?: string
  readonly isInline?: boolean
  readonly contentId?: string
}
export interface MailAttachmentSession {
  /** Preauthenticated credential. Never log this value. */
  readonly uploadUrl: string
  readonly expirationDateTime: string
  readonly nextExpectedRanges: readonly string[]
}
export interface MailAttachmentUploadResult {
  /** Opaque attachment ID returned by Graph or Outlook. */
  readonly id: string
}
