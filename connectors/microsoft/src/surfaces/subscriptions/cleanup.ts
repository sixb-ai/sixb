import { MicrosoftApiError } from "../../errors"
import type { MicrosoftSubscriptionsResource } from "."

/**
 * Deletes the subscriptions one person made that deliver to `route`, and returns how many of them
 * Graph would not delete.
 *
 * Listing with a person's token returns this application's subscriptions for that person, but an
 * administrator with `Subscription.Read.All` sees everyone's, so only those they created count.
 */
export async function deletePersonalSubscriptions(
  subscriptions: MicrosoftSubscriptionsResource,
  accountId: string,
  route: string
): Promise<{ readonly deleted: number; readonly failed: number }> {
  const ids: string[] = []
  for await (const subscription of subscriptions.listAll()) {
    if (subscription.creatorId === accountId && deliversTo(subscription.notificationUrl, route))
      ids.push(subscription.id)
  }
  let failed = 0
  for (const id of ids) {
    try {
      await subscriptions.delete(id)
    } catch (error) {
      // Gone already: expired, or removed by Graph since the listing.
      if (!(error instanceof MicrosoftApiError && error.status === 404)) failed++
    }
  }
  return { deleted: ids.length - failed, failed }
}

function deliversTo(notificationUrl: string | undefined, route: string): boolean {
  if (notificationUrl === undefined) return false
  try {
    // The API may sit behind a path prefix; the route always ends the path.
    return new URL(notificationUrl).pathname.endsWith(route)
  } catch {
    return false
  }
}
