import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type { ContactSubscribeOptions } from "../../types/contacts"
import type { MicrosoftSubscription } from "../../types/subscriptions"
import { mailboxPath } from "../mail/common"
import { subscribeOutlook } from "../subscriptions/outlook"
import { type ContactExtensionsResource, contactExtensionsResource } from "./extensions"
import { type ContactFoldersResource, contactFoldersResource } from "./folders"
import { type ContactItemsResource, contactItemsResource } from "./items"
import { type ContactPhotoResource, contactPhotoResource } from "./photo"

/** Personal Outlook contacts. Every method takes the mailbox's Entra user ID or UPN. */
export interface ContactsSurface {
  readonly items: ContactItemsResource
  readonly folders: ContactFoldersResource
  readonly photo: ContactPhotoResource
  readonly extensions: ContactExtensionsResource
  /** Notifies about every personal contact in the mailbox, in any folder. */
  subscribe(mailbox: string, options: ContactSubscribeOptions): Promise<MicrosoftSubscription>
}
export function contactsSurface(http: MicrosoftHttp, webhookSecret?: string): ContactsSurface {
  return {
    items: contactItemsResource(http),
    folders: contactFoldersResource(http),
    photo: contactPhotoResource(http),
    extensions: contactExtensionsResource(http),
    async subscribe(mailbox, options) {
      // Graph has no folder-scoped contact resource; never widen a caller's folder to the mailbox.
      if ("folderId" in options)
        throw new MicrosoftConfigurationError(
          "Contact subscriptions cover the whole mailbox and do not accept folderId."
        )
      return subscribeOutlook(
        http,
        webhookSecret,
        "contact",
        `${mailboxPath(mailbox)}/contacts`,
        options
      )
    },
  }
}
