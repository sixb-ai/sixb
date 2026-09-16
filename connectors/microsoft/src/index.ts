export type {
  MicrosoftAuthOptions,
  MicrosoftClientCertificate,
  MicrosoftTokenContext,
} from "./auth/types"
export type { MicrosoftClient } from "./client"
export type { GraphErrorDetail } from "./errors"
export {
  MicrosoftApiError,
  MicrosoftAuthError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "./errors"
export { type MicrosoftConnector, microsoft } from "./microsoft"
export type { DrivesSurface } from "./surfaces/drives"
export type { DriveDeltaResource } from "./surfaces/drives/delta"
export type { CreateFolderOptions, DriveItemsResource, MoveOptions } from "./surfaces/drives/items"
export type {
  CreateUploadSessionOptions,
  DriveUploadsResource,
  UploadOptions,
  UploadTarget,
} from "./surfaces/drives/uploads"
export { MicrosoftUploadError } from "./surfaces/drives/uploads"
export type { MailSurface } from "./surfaces/mail"
export type { MailAttachmentsResource } from "./surfaces/mail/attachments"
export { MicrosoftMailUploadError } from "./surfaces/mail/attachments"
export type { MailFolderDeltaResource, MailMessageDeltaResource } from "./surfaces/mail/delta"
export type { MailFoldersResource } from "./surfaces/mail/folders"
export type { MailMessagesResource } from "./surfaces/mail/messages"
export { MicrosoftMailSubmissionError } from "./surfaces/mail/messages"
export type { SitesResource } from "./surfaces/sites"
export type * from "./types/common"
export type * from "./types/files"
export type * from "./types/mail"
