import type { MicrosoftHttp } from "../../http"
import type { MailSubscribeOptions, MicrosoftSubscription } from "../../types/subscriptions"
import { subscribeMailbox } from "../subscriptions"
import { attachmentsResource, type MailAttachmentsResource } from "./attachments"
import { foldersResource, type MailFoldersResource } from "./folders"
import { type MailMessagesResource, messagesResource } from "./messages"

export interface MailSurface {
  readonly messages: MailMessagesResource
  readonly folders: MailFoldersResource
  readonly attachments: MailAttachmentsResource
  subscribe(mailbox: string, options: MailSubscribeOptions): Promise<MicrosoftSubscription>
}
export function mailSurface(http: MicrosoftHttp, webhookSecret?: string): MailSurface {
  return {
    messages: messagesResource(http),
    folders: foldersResource(http),
    attachments: attachmentsResource(http),
    subscribe(mailbox, options) {
      return subscribeMailbox(http, mailbox, webhookSecret, options)
    },
  }
}
