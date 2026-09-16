import type { MicrosoftHttp } from "../../http"
import { attachmentsResource, type MailAttachmentsResource } from "./attachments"
import { foldersResource, type MailFoldersResource } from "./folders"
import { type MailMessagesResource, messagesResource } from "./messages"

export interface MailSurface {
  readonly messages: MailMessagesResource
  readonly folders: MailFoldersResource
  readonly attachments: MailAttachmentsResource
}
export function mailSurface(http: MicrosoftHttp): MailSurface {
  return {
    messages: messagesResource(http),
    folders: foldersResource(http),
    attachments: attachmentsResource(http),
  }
}
