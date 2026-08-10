import type { UnipileHttp } from "../http"
import { listAllCursor } from "../pagination"
import type {
  UnipileCreateWebhookInput,
  UnipileWebhook,
  UnipileWebhookCreated,
  UnipileWebhookDeleted,
  UnipileWebhookHeader,
  UnipileWebhookListOptions,
  UnipileWebhooksResponse,
} from "../types"
import { assertHttpUrl, assertLimit, assertNonEmpty, pathId } from "../validation"
import { UNIPILE_WEBHOOK_SECRET_HEADER } from "../webhooks"

export interface WebhooksResource {
  /** `GET /webhooks` */
  list(options?: UnipileWebhookListOptions): Promise<UnipileWebhooksResponse>
  /** Cursor iterator over `GET /webhooks`. */
  listAll(options?: UnipileWebhookListOptions): AsyncIterable<UnipileWebhook>
  /** `POST /webhooks` */
  create(input: UnipileCreateWebhookInput): Promise<UnipileWebhookCreated>
  /** `DELETE /webhooks/{webhookId}` */
  delete(webhookId: string): Promise<UnipileWebhookDeleted>
}

export function createWebhooksResource(
  http: UnipileHttp,
  webhookSecret?: string
): WebhooksResource {
  const resource: WebhooksResource = {
    list(options) {
      assertLimit(options?.limit)
      return http.get("webhooks", { limit: options?.limit, cursor: options?.cursor }, true)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    create(input) {
      assertHttpUrl(input.request_url, "request_url")
      if (input.account_ids) {
        for (const accountId of input.account_ids) {
          assertNonEmpty(accountId, "account_ids entry")
        }
      }
      const format = input.format ?? "json"
      return http.post("webhooks", {
        ...input,
        format,
        headers: withDeliveryHeaders(input.headers, webhookSecret, format),
      })
    },
    delete(webhookId) {
      return http.delete(`webhooks/${pathId(webhookId, "webhook id")}`)
    },
  }

  return resource
}

function withDeliveryHeaders(
  headers: readonly UnipileWebhookHeader[] | undefined,
  secret: string | undefined,
  format: "json" | "form"
): readonly UnipileWebhookHeader[] | undefined {
  const next = (headers ?? []).filter(
    (header) => !secret || header.key.toLowerCase() !== UNIPILE_WEBHOOK_SECRET_HEADER.toLowerCase()
  )

  if (format === "json" && !next.some((header) => header.key.toLowerCase() === "content-type")) {
    next.unshift({ key: "Content-Type", value: "application/json" })
  }
  if (secret) {
    next.push({ key: UNIPILE_WEBHOOK_SECRET_HEADER, value: secret })
  }

  return next.length > 0 ? next : undefined
}
