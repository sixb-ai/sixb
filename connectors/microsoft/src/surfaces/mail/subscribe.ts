import type { ClientStateSource } from "../../client-state"
import type { MicrosoftHttp } from "../../http"
import type {
  MailEnsureSubscriptionOptions,
  MailSubscribeOptions,
  MicrosoftSubscription,
  SubscriptionEnsureResult,
} from "../../types/subscriptions"
import { ensureOutlook, subscribeOutlook } from "../subscriptions/outlook"
import { folderPath, mailboxPath } from "./common"

const messages = (mailbox: string, folderId: string | undefined) =>
  `${folderId === undefined ? mailboxPath(mailbox) : folderPath(mailbox, folderId)}/messages`

export function subscribeMailbox(
  http: MicrosoftHttp,
  mailbox: string,
  clientState: ClientStateSource | undefined,
  options: MailSubscribeOptions
): Promise<MicrosoftSubscription> {
  return subscribeOutlook(http, clientState, "mail", messages(mailbox, options.folderId), options)
}

export function ensureMailboxSubscription(
  http: MicrosoftHttp,
  mailbox: string,
  clientState: ClientStateSource | undefined,
  options: MailEnsureSubscriptionOptions
): Promise<SubscriptionEnsureResult> {
  return ensureOutlook(http, clientState, "mail", messages(mailbox, options.folderId), options)
}
