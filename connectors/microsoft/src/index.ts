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
export type { CalendarSurface } from "./surfaces/calendar"
export type { CalendarAttachmentsResource } from "./surfaces/calendar/attachments"
export { MicrosoftCalendarUploadError } from "./surfaces/calendar/attachments"
export type { CalendarsResource } from "./surfaces/calendar/calendars"
export { MicrosoftCalendarMutationError } from "./surfaces/calendar/common"
export type { CalendarDeltaResource } from "./surfaces/calendar/delta"
export type { CalendarEventsResource } from "./surfaces/calendar/events"
export type { CalendarViewResource } from "./surfaces/calendar/view"
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
export type { SubscriptionsResource } from "./surfaces/subscriptions"
export { MicrosoftSubscriptionMutationError } from "./surfaces/subscriptions"
export type * from "./types/calendar"
export type * from "./types/common"
export type * from "./types/files"
export type * from "./types/mail"
export type * from "./types/subscriptions"
