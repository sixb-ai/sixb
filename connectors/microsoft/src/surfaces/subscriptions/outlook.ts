import type { ClientStateSource } from "../../client-state"
import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type {
  MicrosoftSubscription,
  SubscriptionChangeType,
  SubscriptionChangeTypes,
  SubscriptionEnsureInput,
  SubscriptionEnsureResult,
} from "../../types/subscriptions"
import { subscriptionsResource } from "."

// Outlook messages, events and contacts share this limit; generic renewals leave it to Graph.
const OUTLOOK_MAX_LIFETIME_MS = 10_080 * 60_000

type OutlookKind = "mail" | "contact"

interface OutlookTarget {
  readonly signal?: AbortSignal
  readonly changeTypes: readonly SubscriptionChangeType[]
  readonly notificationUrl: string
  readonly lifecycleNotificationUrl?: string
}

export interface OutlookSubscribeOptions extends OutlookTarget {
  readonly expirationDateTime: string
}

export interface OutlookEnsureOptions extends OutlookTarget {
  readonly renewWithinMs?: number
  readonly lifetimeMs?: number
}

/** Basic subscription to an Outlook resource, delivered to the connector's own webhook receiver. */
export async function subscribeOutlook(
  http: MicrosoftHttp,
  clientState: ClientStateSource | undefined,
  kind: OutlookKind,
  resource: string,
  options: OutlookSubscribeOptions
): Promise<MicrosoftSubscription> {
  const input = outlookSubscription(clientState, kind, resource, options)
  if (Date.parse(options.expirationDateTime) > Date.now() + OUTLOOK_MAX_LIFETIME_MS)
    throw new MicrosoftConfigurationError(
      `${label(kind)} subscription expiration must be within seven days.`
    )
  return subscriptionsResource(http).create(
    { ...input, expirationDateTime: options.expirationDateTime },
    { signal: options.signal, immutableIds: true }
  )
}

/** Keeps that subscription alive; see `subscriptions.ensure`. */
export async function ensureOutlook(
  http: MicrosoftHttp,
  clientState: ClientStateSource | undefined,
  kind: OutlookKind,
  resource: string,
  options: OutlookEnsureOptions
): Promise<SubscriptionEnsureResult> {
  const input = outlookSubscription(clientState, kind, resource, options)
  if (options.lifetimeMs !== undefined && options.lifetimeMs > OUTLOOK_MAX_LIFETIME_MS)
    throw new MicrosoftConfigurationError(
      `${label(kind)} subscription lifetime must be within seven days.`
    )
  return subscriptionsResource(http).ensure(input, {
    signal: options.signal,
    immutableIds: true,
    renewWithinMs: options.renewWithinMs,
    lifetimeMs: options.lifetimeMs,
  })
}

function outlookSubscription(
  clientState: ClientStateSource | undefined,
  kind: OutlookKind,
  resource: string,
  options: OutlookTarget
): SubscriptionEnsureInput {
  if (clientState === undefined)
    throw new MicrosoftConfigurationError(
      `webhookSecret is required to subscribe to ${kind} notifications.`
    )
  if (
    !Array.isArray(options.changeTypes) ||
    !options.changeTypes.length ||
    options.changeTypes.some((type) => !["created", "updated", "deleted"].includes(type))
  )
    throw new MicrosoftConfigurationError("changeTypes must contain created, updated or deleted.")
  return {
    resource,
    changeType: [...new Set(options.changeTypes)].join(",") as SubscriptionChangeTypes,
    notificationUrl: options.notificationUrl,
    lifecycleNotificationUrl: options.lifecycleNotificationUrl ?? options.notificationUrl,
    clientState: clientState(),
    includeResourceData: false,
  }
}

const label = (kind: OutlookKind) => (kind === "mail" ? "Mail" : "Contact")
