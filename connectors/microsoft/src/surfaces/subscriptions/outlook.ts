import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type {
  MicrosoftSubscription,
  SubscriptionChangeType,
  SubscriptionChangeTypes,
} from "../../types/subscriptions"
import { subscriptionsResource } from "."
import { validateWebhookSecret } from "./validation"

export interface OutlookSubscribeOptions {
  readonly signal?: AbortSignal
  readonly changeTypes: readonly SubscriptionChangeType[]
  readonly notificationUrl: string
  readonly lifecycleNotificationUrl?: string
  readonly expirationDateTime: string
}

/** Basic subscription to an Outlook resource, delivered to the connector's own webhook receiver. */
export async function subscribeOutlook(
  http: MicrosoftHttp,
  secret: string | undefined,
  kind: "mail" | "contact",
  resource: string,
  options: OutlookSubscribeOptions
): Promise<MicrosoftSubscription> {
  if (secret === undefined)
    throw new MicrosoftConfigurationError(
      `webhookSecret is required to subscribe to ${kind} notifications.`
    )
  validateWebhookSecret(secret)
  if (
    !Array.isArray(options.changeTypes) ||
    !options.changeTypes.length ||
    options.changeTypes.some((type) => !["created", "updated", "deleted"].includes(type))
  )
    throw new MicrosoftConfigurationError("changeTypes must contain created, updated or deleted.")
  // Outlook messages, events and contacts share this limit; generic renewals leave it to Graph.
  if (Date.parse(options.expirationDateTime) > Date.now() + 10_080 * 60_000)
    throw new MicrosoftConfigurationError(
      `${kind === "mail" ? "Mail" : "Contact"} subscription expiration must be within seven days.`
    )
  return subscriptionsResource(http).create(
    {
      resource,
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
