import type { ClientStateSource } from "../../client-state"
import type { MicrosoftHttp } from "../../http"
import type { MailSubscribeOptions, MicrosoftSubscription } from "../../types/subscriptions"
import { subscribeOutlook } from "../subscriptions/outlook"
import { folderPath, mailboxPath } from "./common"

export async function subscribeMailbox(
  http: MicrosoftHttp,
  mailbox: string,
  clientState: ClientStateSource | undefined,
  options: MailSubscribeOptions
): Promise<MicrosoftSubscription> {
  const target =
    options.folderId === undefined ? mailboxPath(mailbox) : folderPath(mailbox, options.folderId)
  return subscribeOutlook(http, clientState, "mail", `${target}/messages`, options)
}
