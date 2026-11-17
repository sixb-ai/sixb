import type { ClientStateSource } from "../../client-state"
import type { MicrosoftHttp } from "../../http"
import type {
  MailEnsureSubscriptionOptions,
  MailSubscribeOptions,
  MicrosoftSubscription,
  SubscriptionEnsureResult,
} from "../../types/subscriptions"
import { attachmentsResource, type MailAttachmentsResource } from "./attachments"
import { foldersResource, type MailFoldersResource } from "./folders"
import { type MailMessagesResource, messagesResource } from "./messages"
import { ensureMailboxSubscription, subscribeMailbox } from "./subscribe"

export interface MailSurface {
  readonly messages: MailMessagesResource
  readonly folders: MailFoldersResource
  readonly attachments: MailAttachmentsResource
  subscribe(mailbox: string, options: MailSubscribeOptions): Promise<MicrosoftSubscription>
  /** Keeps the mailbox's subscription alive; call it on a schedule. See `subscriptions.ensure`. */
  ensureSubscription(
    mailbox: string,
    options: MailEnsureSubscriptionOptions
  ): Promise<SubscriptionEnsureResult>
}
export function mailSurface(http: MicrosoftHttp, clientState?: ClientStateSource): MailSurface {
  return {
    messages: messagesResource(http),
    folders: foldersResource(http),
    attachments: attachmentsResource(http),
    subscribe(mailbox, options) {
      return subscribeMailbox(http, mailbox, clientState, options)
    },
    ensureSubscription(mailbox, options) {
      return ensureMailboxSubscription(http, mailbox, clientState, options)
    },
  }
}
