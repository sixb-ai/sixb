/**
 * Types for the complete Gmail API v1 REST surface.
 *
 * Response resources deliberately remain open: partial responses can omit
 * fields and Google can add fields without requiring a connector release.
 * Named properties mirror the Gmail v1 Discovery document for editor
 * discoverability; unknown response fields are preserved by the HTTP layer.
 */
import type { QueryParams } from "./common"

export type GmailMessageFormat = "minimal" | "full" | "raw" | "metadata"
export type GmailThreadFormat = Exclude<GmailMessageFormat, "raw">
export type GmailInternalDateSource = "receivedTime" | "dateHeader"
export type GmailHistoryType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved"
export type GmailDisposition =
  | "dispositionUnspecified"
  | "leaveInInbox"
  | "archive"
  | "trash"
  | "markRead"
export type GmailVerificationStatus = "verificationStatusUnspecified" | "accepted" | "pending"

export interface ClassificationLabelFieldValue {
  readonly fieldId?: string
  readonly selection?: string
  readonly [key: string]: unknown
}

export interface ClassificationLabelValue {
  readonly labelId?: string
  readonly fields?: readonly ClassificationLabelFieldValue[]
  readonly [key: string]: unknown
}

export interface MessagePartHeader {
  readonly name?: string
  readonly value?: string
  readonly [key: string]: unknown
}

export interface MessagePartBody {
  readonly attachmentId?: string
  /** Base64url-encoded body data. */
  readonly data?: string
  readonly size?: number
  readonly [key: string]: unknown
}

export interface MessagePart {
  readonly partId?: string
  readonly mimeType?: string
  readonly filename?: string
  readonly headers?: readonly MessagePartHeader[]
  readonly body?: MessagePartBody
  readonly parts?: readonly MessagePart[]
  readonly [key: string]: unknown
}

export interface Message {
  readonly id?: string
  readonly threadId?: string
  readonly labelIds?: readonly string[]
  readonly snippet?: string
  readonly historyId?: string
  /** Internal creation time in milliseconds since the Unix epoch. */
  readonly internalDate?: string
  readonly payload?: MessagePart
  readonly sizeEstimate?: number
  /** RFC 2822 message encoded as base64url. */
  readonly raw?: string
  readonly classificationLabelValues?: readonly ClassificationLabelValue[]
  readonly [key: string]: unknown
}

export interface ListMessagesResponse {
  readonly messages?: readonly Message[]
  readonly nextPageToken?: string
  readonly resultSizeEstimate?: number
}

export type MessagesListOptions = QueryParams & {
  readonly maxResults?: number
  readonly pageToken?: string
  readonly q?: string
  readonly labelIds?: readonly string[]
  readonly includeSpamTrash?: boolean
}

export type MessageGetOptions = QueryParams & {
  readonly format?: GmailMessageFormat
  readonly metadataHeaders?: readonly string[]
}

export type MessageImportOptions = QueryParams & {
  readonly internalDateSource?: GmailInternalDateSource
  readonly neverMarkSpam?: boolean
  readonly processForCalendar?: boolean
  readonly deleted?: boolean
}

export type MessageInsertOptions = QueryParams & {
  readonly internalDateSource?: GmailInternalDateSource
  readonly deleted?: boolean
}

export interface ModifyMessageRequest {
  readonly addLabelIds?: readonly string[]
  readonly removeLabelIds?: readonly string[]
  readonly addClassificationLabels?: readonly ClassificationLabelValue[]
  readonly removeClassificationLabelIds?: readonly string[]
}

export interface BatchModifyMessagesRequest extends ModifyMessageRequest {
  readonly ids: readonly string[]
}

export interface BatchDeleteMessagesRequest {
  readonly ids: readonly string[]
}

export interface Draft {
  readonly id?: string
  readonly message?: Message
  readonly [key: string]: unknown
}

export interface ListDraftsResponse {
  readonly drafts?: readonly Draft[]
  readonly nextPageToken?: string
  readonly resultSizeEstimate?: number
}

export type DraftsListOptions = QueryParams & {
  readonly maxResults?: number
  readonly pageToken?: string
  readonly q?: string
  readonly includeSpamTrash?: boolean
}

export type DraftGetOptions = QueryParams & {
  readonly format?: GmailMessageFormat
}

export interface Thread {
  readonly id?: string
  readonly snippet?: string
  readonly historyId?: string
  readonly messages?: readonly Message[]
  readonly [key: string]: unknown
}

export interface ListThreadsResponse {
  readonly threads?: readonly Thread[]
  readonly nextPageToken?: string
  readonly resultSizeEstimate?: number
}

export type ThreadsListOptions = QueryParams & {
  readonly maxResults?: number
  readonly pageToken?: string
  readonly q?: string
  readonly labelIds?: readonly string[]
  readonly includeSpamTrash?: boolean
}

export type ThreadGetOptions = QueryParams & {
  readonly format?: GmailThreadFormat
  readonly metadataHeaders?: readonly string[]
}

export interface ModifyThreadRequest {
  readonly addLabelIds?: readonly string[]
  readonly removeLabelIds?: readonly string[]
}

export interface LabelColor {
  readonly textColor?: string
  readonly backgroundColor?: string
  readonly [key: string]: unknown
}

export interface Label {
  readonly id?: string
  readonly name?: string
  readonly messageListVisibility?: "show" | "hide"
  readonly labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide"
  readonly type?: "system" | "user"
  readonly messagesTotal?: number
  readonly messagesUnread?: number
  readonly threadsTotal?: number
  readonly threadsUnread?: number
  readonly color?: LabelColor
  readonly [key: string]: unknown
}

export interface ListLabelsResponse {
  readonly labels?: readonly Label[]
}

export interface HistoryMessageAdded {
  readonly message?: Message
  readonly [key: string]: unknown
}

export interface HistoryMessageDeleted {
  readonly message?: Message
  readonly [key: string]: unknown
}

export interface HistoryLabelAdded {
  readonly message?: Message
  readonly labelIds?: readonly string[]
  readonly [key: string]: unknown
}

export interface HistoryLabelRemoved {
  readonly message?: Message
  readonly labelIds?: readonly string[]
  readonly [key: string]: unknown
}

export interface History {
  readonly id?: string
  readonly messages?: readonly Message[]
  readonly messagesAdded?: readonly HistoryMessageAdded[]
  readonly messagesDeleted?: readonly HistoryMessageDeleted[]
  readonly labelsAdded?: readonly HistoryLabelAdded[]
  readonly labelsRemoved?: readonly HistoryLabelRemoved[]
  readonly [key: string]: unknown
}

export interface ListHistoryResponse {
  readonly history?: readonly History[]
  readonly nextPageToken?: string
  /** Current mailbox history id, returned on the final page. */
  readonly historyId?: string
}

export type HistoryListOptions = QueryParams & {
  readonly startHistoryId: string
  readonly maxResults?: number
  readonly pageToken?: string
  readonly labelId?: string
  readonly historyTypes?: readonly GmailHistoryType[]
}

export interface Profile {
  readonly emailAddress?: string
  readonly messagesTotal?: number
  readonly threadsTotal?: number
  readonly historyId?: string
  readonly [key: string]: unknown
}

export interface WatchRequest {
  readonly topicName: string
  readonly labelIds?: readonly string[]
  /** Deprecated by Google; use `labelFilterBehavior`. */
  readonly labelFilterAction?: "include" | "exclude"
  readonly labelFilterBehavior?: "include" | "exclude"
}

export interface WatchResponse {
  readonly historyId?: string
  /** Watch expiration in milliseconds since the Unix epoch. */
  readonly expiration?: string
  readonly [key: string]: unknown
}

export interface AutoForwarding {
  readonly enabled?: boolean
  readonly emailAddress?: string
  readonly disposition?: GmailDisposition
  readonly [key: string]: unknown
}

export interface ImapSettings {
  readonly enabled?: boolean
  readonly autoExpunge?: boolean
  readonly expungeBehavior?: "expungeBehaviorUnspecified" | "archive" | "trash" | "deleteForever"
  readonly maxFolderSize?: number
  readonly [key: string]: unknown
}

export interface LanguageSettings {
  readonly displayLanguage?: string
  readonly [key: string]: unknown
}

export interface PopSettings {
  readonly accessWindow?: "accessWindowUnspecified" | "disabled" | "fromNowOn" | "allMail"
  readonly disposition?: GmailDisposition
  readonly [key: string]: unknown
}

export interface VacationSettings {
  readonly enableAutoReply?: boolean
  readonly responseSubject?: string
  readonly responseBodyPlainText?: string
  readonly responseBodyHtml?: string
  readonly restrictToContacts?: boolean
  readonly restrictToDomain?: boolean
  readonly startTime?: string
  readonly endTime?: string
  readonly [key: string]: unknown
}

export interface ForwardingAddress {
  readonly forwardingEmail?: string
  readonly verificationStatus?: GmailVerificationStatus
  readonly [key: string]: unknown
}

export interface ListForwardingAddressesResponse {
  readonly forwardingAddresses?: readonly ForwardingAddress[]
}

export interface FilterCriteria {
  readonly from?: string
  readonly to?: string
  readonly subject?: string
  readonly query?: string
  readonly negatedQuery?: string
  readonly hasAttachment?: boolean
  readonly excludeChats?: boolean
  readonly size?: number
  readonly sizeComparison?: "unspecified" | "smaller" | "larger"
  readonly [key: string]: unknown
}

export interface FilterAction {
  readonly addLabelIds?: readonly string[]
  readonly removeLabelIds?: readonly string[]
  readonly forward?: string
  readonly [key: string]: unknown
}

export interface Filter {
  readonly id?: string
  readonly criteria?: FilterCriteria
  readonly action?: FilterAction
  readonly [key: string]: unknown
}

export interface ListFiltersResponse {
  readonly filter?: readonly Filter[]
}

export type DelegateVerificationStatus = GmailVerificationStatus | "rejected" | "expired"

export interface Delegate {
  readonly delegateEmail?: string
  readonly verificationStatus?: DelegateVerificationStatus
  readonly [key: string]: unknown
}

export interface ListDelegatesResponse {
  readonly delegates?: readonly Delegate[]
}

export interface SmtpMsa {
  readonly host?: string
  readonly port?: number
  readonly username?: string
  readonly password?: string
  readonly securityMode?: "securityModeUnspecified" | "none" | "ssl" | "starttls"
  readonly [key: string]: unknown
}

export interface SendAs {
  readonly sendAsEmail?: string
  readonly displayName?: string
  readonly replyToAddress?: string
  readonly signature?: string
  readonly isPrimary?: boolean
  readonly isDefault?: boolean
  readonly treatAsAlias?: boolean
  readonly smtpMsa?: SmtpMsa
  readonly verificationStatus?: GmailVerificationStatus
  readonly [key: string]: unknown
}

export interface ListSendAsResponse {
  readonly sendAs?: readonly SendAs[]
}

export interface SmimeInfo {
  /** PKCS#12 data encoded as base64. Input only. */
  readonly pkcs12?: string
  readonly encryptedKeyPassword?: string
  readonly pem?: string
  readonly id?: string
  readonly isDefault?: boolean
  readonly issuerCn?: string
  readonly expiration?: string
  readonly [key: string]: unknown
}

export interface ListSmimeInfoResponse {
  readonly smimeInfo?: readonly SmimeInfo[]
}

export interface SignAndEncryptKeyPairs {
  readonly signingKeyPairId?: string
  readonly encryptionKeyPairId?: string
  readonly [key: string]: unknown
}

export interface CseIdentity {
  readonly emailAddress?: string
  readonly primaryKeyPairId?: string
  readonly signAndEncryptKeyPairs?: SignAndEncryptKeyPairs
  readonly [key: string]: unknown
}

export interface ListCseIdentitiesResponse {
  readonly cseIdentities?: readonly CseIdentity[]
  readonly nextPageToken?: string
}

export type CseListOptions = QueryParams & {
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface KaclsKeyMetadata {
  readonly kaclsUri?: string
  readonly kaclsData?: string
  readonly [key: string]: unknown
}

export interface HardwareKeyMetadata {
  readonly description?: string
  readonly [key: string]: unknown
}

export interface CsePrivateKeyMetadata {
  readonly privateKeyMetadataId?: string
  readonly kaclsKeyMetadata?: KaclsKeyMetadata
  readonly hardwareKeyMetadata?: HardwareKeyMetadata
  readonly [key: string]: unknown
}

export interface CseKeyPair {
  /** PKCS#7 certificate chain encoded as base64. Input only. */
  readonly pkcs7?: string
  readonly keyPairId?: string
  readonly pem?: string
  readonly enablementState?: "stateUnspecified" | "enabled" | "disabled"
  readonly disableTime?: string
  readonly privateKeyMetadata?: readonly CsePrivateKeyMetadata[]
  readonly subjectEmailAddresses?: readonly string[]
  readonly [key: string]: unknown
}

export interface ListCseKeyPairsResponse {
  readonly cseKeyPairs?: readonly CseKeyPair[]
  readonly nextPageToken?: string
}

export type CseKeyPairCreateOptions = QueryParams & {
  readonly chainValidation?: "all" | "none"
}
