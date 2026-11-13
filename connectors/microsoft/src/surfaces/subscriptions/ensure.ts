import { MicrosoftApiError, MicrosoftConfigurationError } from "../../errors"
import type {
  MicrosoftSubscription,
  SubscriptionEnsureInput,
  SubscriptionEnsureOptions,
  SubscriptionEnsureResult,
} from "../../types/subscriptions"
import { MicrosoftSubscriptionMutationError, type MicrosoftSubscriptionsResource } from "."

const DAY_MS = 86_400_000

/**
 * Keeps one subscription alive without storing anything: Graph is the record. Listing returns
 * this application's subscriptions, and with a person's token only theirs, so the one with the
 * same resource and URL is the one to keep. Safe to call on a schedule: it renews only once less
 * than `renewWithinMs` is left.
 */
export async function ensureSubscription(
  subscriptions: MicrosoftSubscriptionsResource,
  input: SubscriptionEnsureInput,
  options: SubscriptionEnsureOptions = {}
): Promise<SubscriptionEnsureResult> {
  const renewWithinMs = duration(options.renewWithinMs ?? 3 * DAY_MS, "renewWithinMs")
  const lifetimeMs = duration(options.lifetimeMs ?? 6 * DAY_MS, "lifetimeMs")
  if (renewWithinMs >= lifetimeMs)
    throw new MicrosoftConfigurationError("renewWithinMs must be shorter than lifetimeMs.")
  const request = { signal: options.signal }
  const expiry = () => new Date(Date.now() + lifetimeMs).toISOString()

  const [current, ...duplicates] = await matching(subscriptions, input, request.signal)
  for (const duplicate of duplicates) {
    // Each duplicate delivers every notification again. One that won't go is retried next call.
    await subscriptions.delete(duplicate.id, request).catch(() => undefined)
  }

  if (current) {
    if (Date.parse(current.expirationDateTime ?? "") > Date.now() + renewWithinMs)
      return { subscription: current, action: "kept" }
    try {
      const renewed = await subscriptions.update(
        current.id,
        { expirationDateTime: expiry() },
        request
      )
      return { subscription: renewed, action: "renewed" }
    } catch (error) {
      // Expired or removed since the listing: create it again.
      if (!(error instanceof MicrosoftApiError && error.status === 404)) throw error
    }
  }

  try {
    const created = await subscriptions.create({ ...input, expirationDateTime: expiry() }, options)
    return { subscription: created, action: "created" }
  } catch (error) {
    const conflict = error instanceof MicrosoftApiError && error.status === 409
    if (!conflict && !(error instanceof MicrosoftSubscriptionMutationError)) throw error
    const [adopted] = await matching(subscriptions, input, request.signal)
    if (!adopted) throw error
    return { subscription: adopted, action: "adopted" }
  }
}

/** Subscriptions to the same resource and URL, the longest-lasting first. */
async function matching(
  subscriptions: MicrosoftSubscriptionsResource,
  input: SubscriptionEnsureInput,
  signal: AbortSignal | undefined
): Promise<MicrosoftSubscription[]> {
  const resource = normalizedResource(input.resource)
  const found: MicrosoftSubscription[] = []
  for await (const subscription of subscriptions.listAll({ signal })) {
    if (
      subscription.notificationUrl === input.notificationUrl &&
      subscription.resource !== undefined &&
      normalizedResource(subscription.resource) === resource
    )
      found.push(subscription)
  }
  const expires = (subscription: MicrosoftSubscription) =>
    Date.parse(subscription.expirationDateTime ?? "") || 0
  return found.sort((left, right) => expires(right) - expires(left))
}

/** Graph may echo a resource decoded, without its leading slash, or in another letter case. */
function normalizedResource(resource: string): string {
  let decoded = resource
  try {
    decoded = decodeURIComponent(resource)
  } catch {
    // Not percent-encoded; compare it as written.
  }
  return decoded.replace(/^\/+/, "").toLowerCase()
}

function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new MicrosoftConfigurationError(`${name} must be a positive number of milliseconds.`)
  return value
}
