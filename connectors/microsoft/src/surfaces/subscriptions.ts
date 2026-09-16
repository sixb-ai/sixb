import { MicrosoftConfigurationError } from "../errors"
import { checkEmpty, type MicrosoftHttp } from "../http"
import { allPages, page } from "../pagination"
import type { GraphPage, RequestOptions } from "../types/common"
import type { MailSubscribeOptions, MicrosoftSubscription } from "../types/subscriptions"
import { httpsUrl, nonEmpty, resource, segment } from "../validation"
import { folderPath, mailboxPath, mailHeaders } from "./mail/common"

export interface MicrosoftSubscriptionsResource {
  list(options?: RequestOptions): Promise<GraphPage<MicrosoftSubscription>>
  listAll(options?: RequestOptions): AsyncIterable<MicrosoftSubscription>
  get(id: string, options?: RequestOptions): Promise<MicrosoftSubscription>
  renew(
    id: string,
    expirationDateTime: string,
    options?: RequestOptions
  ): Promise<MicrosoftSubscription>
  delete(id: string, options?: RequestOptions): Promise<void>
  reauthorize(id: string, options?: RequestOptions): Promise<void>
}

export function validateWebhookSecret(secret: string): void {
  nonEmpty(secret, "webhookSecret")
  if (secret.length > 128)
    throw new MicrosoftConfigurationError("webhookSecret must not exceed 128 characters.")
}

function expiry(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 10_080 * 60_000) {
    throw new MicrosoftConfigurationError(
      "expirationDateTime must be in the future and within seven days."
    )
  }
  return new Date(time).toISOString()
}

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
    !options.changeTypes.length ||
    options.changeTypes.some((type) => !["created", "updated", "deleted"].includes(type))
  ) {
    throw new MicrosoftConfigurationError("changeTypes must contain created, updated or deleted.")
  }
  const notificationUrl = httpsUrl(options.notificationUrl).href
  const lifecycleNotificationUrl = httpsUrl(
    options.lifecycleNotificationUrl ?? options.notificationUrl
  ).href
  const target =
    options.folderId === undefined ? mailboxPath(mailbox) : folderPath(mailbox, options.folderId)
  return resource(
    await http.json("subscriptions", {
      method: "POST",
      headers: mailHeaders(),
      signal: options.signal,
      body: {
        resource: `${target}/messages`,
        changeType: [...new Set(options.changeTypes)].join(","),
        notificationUrl,
        lifecycleNotificationUrl,
        expirationDateTime: expiry(options.expirationDateTime),
        clientState: secret,
        includeResourceData: false,
      },
    })
  )
}

export function subscriptionsResource(http: MicrosoftHttp): MicrosoftSubscriptionsResource {
  const path = (id: string) => `subscriptions/${segment(id)}`
  return {
    async list(options) {
      return page(await http.json("subscriptions", { signal: options?.signal }))
    },
    listAll(options) {
      return allPages(http, "subscriptions", options)
    },
    async get(id, options) {
      return resource(await http.json(path(id), { signal: options?.signal }))
    },
    async renew(id, expirationDateTime, options) {
      return resource(
        await http.json(path(id), {
          method: "PATCH",
          signal: options?.signal,
          body: { expirationDateTime: expiry(expirationDateTime) },
        })
      )
    },
    async delete(id, options) {
      await checkEmpty(await http.request(path(id), { method: "DELETE", signal: options?.signal }))
    },
    async reauthorize(id, options) {
      await checkEmpty(
        await http.request(`${path(id)}/reauthorize`, { method: "POST", signal: options?.signal })
      )
    },
  }
}
