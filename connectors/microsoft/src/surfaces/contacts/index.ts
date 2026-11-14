import type { ClientStateSource } from "../../client-state"
import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type {
  ContactEnsureSubscriptionOptions,
  ContactSubscribeOptions,
} from "../../types/contacts"
import type { MicrosoftSubscription, SubscriptionEnsureResult } from "../../types/subscriptions"
import { mailboxPath } from "../mail/common"
import { ensureOutlook, subscribeOutlook } from "../subscriptions/outlook"
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
  /** Keeps the mailbox's contact subscription alive. See `subscriptions.ensure`. */
  ensureSubscription(
    mailbox: string,
    options: ContactEnsureSubscriptionOptions
  ): Promise<SubscriptionEnsureResult>
}
export function contactsSurface(
  http: MicrosoftHttp,
  clientState?: ClientStateSource
): ContactsSurface {
  return {
    items: contactItemsResource(http),
    folders: contactFoldersResource(http),
    photo: contactPhotoResource(http),
    extensions: contactExtensionsResource(http),
    async subscribe(mailbox, options) {
      assertNoFolder(options)
      return subscribeOutlook(http, clientState, "contact", contacts(mailbox), options)
    },
    async ensureSubscription(mailbox, options) {
      assertNoFolder(options)
      return ensureOutlook(http, clientState, "contact", contacts(mailbox), options)
    },
  }
}

const contacts = (mailbox: string) => `${mailboxPath(mailbox)}/contacts`

// Graph has no folder-scoped contact resource; never widen a caller's folder to the mailbox.
function assertNoFolder(options: object): void {
  if ("folderId" in options)
    throw new MicrosoftConfigurationError(
      "Contact subscriptions cover the whole mailbox and do not accept folderId."
    )
}
