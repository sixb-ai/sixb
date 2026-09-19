import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type {
  MailSubscribeOptions,
  MicrosoftSubscription,
  SubscriptionChangeTypes,
} from "../../types/subscriptions"
import { subscriptionsResource } from "../subscriptions"
import { validateWebhookSecret } from "../subscriptions/validation"
import { folderPath, mailboxPath } from "./common"

export async function subscribeMailbox(
  http: MicrosoftHttp,
  mailbox: string,
  secret: string | undefined,
  options: MailSubscribeOptions
): Promise<MicrosoftSubscription> {
  if (secret === undefined)
    throw new MicrosoftConfigurationError(
      "webhookSecret is required to subscribe to mail notifications."
    )
  validateWebhookSecret(secret)
  if (
    !Array.isArray(options.changeTypes) ||
    !options.changeTypes.length ||
    options.changeTypes.some((type) => !["created", "updated", "deleted"].includes(type))
  )
    throw new MicrosoftConfigurationError("changeTypes must contain created, updated or deleted.")
  // Mail's creation helper has a known resource type; generic renewals leave the limit to Graph.
  if (Date.parse(options.expirationDateTime) > Date.now() + 10_080 * 60_000)
    throw new MicrosoftConfigurationError("Mail subscription expiration must be within seven days.")
  const target =
    options.folderId === undefined ? mailboxPath(mailbox) : folderPath(mailbox, options.folderId)
  return subscriptionsResource(http).create(
    {
      resource: `${target}/messages`,
      changeType: [...new Set(options.changeTypes)].join(",") as SubscriptionChangeTypes,
      notificationUrl: options.notificationUrl,
      lifecycleNotificationUrl: options.lifecycleNotificationUrl ?? options.notificationUrl,
      expirationDateTime: options.expirationDateTime,
      clientState: secret,
      includeResourceData: false,
    },
    { signal: options.signal, immutableIds: true }
  )
}
