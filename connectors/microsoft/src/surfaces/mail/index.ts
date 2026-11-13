import type { ClientStateSource } from "../../client-state"
import type { MicrosoftHttp } from "../../http"
import type { MailSubscribeOptions, MicrosoftSubscription } from "../../types/subscriptions"
import { attachmentsResource, type MailAttachmentsResource } from "./attachments"
import { foldersResource, type MailFoldersResource } from "./folders"
import { type MailMessagesResource, messagesResource } from "./messages"
import { subscribeMailbox } from "./subscribe"

export interface MailSurface {
  readonly messages: MailMessagesResource
  readonly folders: MailFoldersResource
  readonly attachments: MailAttachmentsResource
  subscribe(mailbox: string, options: MailSubscribeOptions): Promise<MicrosoftSubscription>
}
export function mailSurface(http: MicrosoftHttp, clientState?: ClientStateSource): MailSurface {
  return {
    messages: messagesResource(http),
    folders: foldersResource(http),
    attachments: attachmentsResource(http),
    subscribe(mailbox, options) {
      return subscribeMailbox(http, mailbox, clientState, options)
    },
  }
}
