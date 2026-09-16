import type { MicrosoftHttp } from "../../http"
import type {
  CalendarAttachment,
  CalendarAttachmentSession,
  CalendarAttachmentUploadResult,
  CalendarFileOptions,
} from "../../types/calendar"
import type { GraphPage, RequestOptions, SelectOptions } from "../../types/common"
import type { FileContent } from "../../types/files"
import { attachmentsResource } from "../mail/attachments"
import { eventPath } from "./common"

export interface CalendarAttachmentsResource {
  list(
    mailbox: string,
    eventId: string,
    options?: SelectOptions
  ): Promise<GraphPage<CalendarAttachment>>
  listAll(
    mailbox: string,
    eventId: string,
    options?: SelectOptions
  ): AsyncIterable<CalendarAttachment>
  get(
    mailbox: string,
    eventId: string,
    id: string,
    options?: SelectOptions
  ): Promise<CalendarAttachment>
  /** File bytes or MIME for item attachments. Reference attachments return Graph's 405. */
  downloadResponse(
    mailbox: string,
    eventId: string,
    id: string,
    options?: RequestOptions
  ): Promise<Response>
  download(
    mailbox: string,
    eventId: string,
    id: string,
    options?: RequestOptions
  ): Promise<Uint8Array>
  delete(mailbox: string, eventId: string, id: string, options?: RequestOptions): Promise<void>
  /** Adds a file to an event; update the event afterward to distribute it to attendees. */
  upload(
    mailbox: string,
    eventId: string,
    name: string,
    content: FileContent,
    options?: CalendarFileOptions
  ): Promise<CalendarAttachmentUploadResult>
  createSession(
    mailbox: string,
    eventId: string,
    name: string,
    size: number,
    options?: CalendarFileOptions
  ): Promise<CalendarAttachmentSession>
  /** Resume at the last acknowledged offset, using the same complete file. No implicit retries. */
  resume(
    session: CalendarAttachmentSession,
    content: FileContent,
    options?: RequestOptions
  ): Promise<CalendarAttachmentUploadResult>
  cancel(session: CalendarAttachmentSession, options?: RequestOptions): Promise<void>
}
export class MicrosoftCalendarUploadError extends Error {
  readonly session: CalendarAttachmentSession
  readonly completionUnknown: boolean
  constructor(session: CalendarAttachmentSession, cause: unknown, completionUnknown: boolean) {
    super(
      `[SixbMicrosoft] Calendar attachment upload interrupted. ${completionUnknown ? "The attachment may exist; inspect the event before restarting." : "Resume the existing session with the same complete file or cancel it."}`,
      { cause }
    )
    this.name = "MicrosoftCalendarUploadError"
    this.session = session
    this.completionUnknown = completionUnknown
  }
}
export function calendarAttachmentsResource(http: MicrosoftHttp): CalendarAttachmentsResource {
  return attachmentsResource(http, { path: eventPath, uploadError: MicrosoftCalendarUploadError })
}
