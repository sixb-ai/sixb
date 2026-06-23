import type { Http } from "../http"
import { pageParams } from "../pagination"
import type {
  CompanyCamWebhook,
  CreateWebhookInput,
  ListWebhooksOptions,
  UpdateWebhookInput,
} from "../types"

export interface WebhooksResource {
  /** `POST /webhooks` */
  create(input: CreateWebhookInput): Promise<CompanyCamWebhook>
  /** `GET /webhooks` */
  list(options?: ListWebhooksOptions): Promise<CompanyCamWebhook[]>
  /** `GET /webhooks/{id}` */
  get(id: string): Promise<CompanyCamWebhook>
  /** `PUT /webhooks/{id}` */
  update(id: string, input: UpdateWebhookInput): Promise<CompanyCamWebhook>
  /** `DELETE /webhooks/{id}` */
  delete(id: string): Promise<void>
}

/**
 * `defaultToken` is the connector's `webhookSecret`; it is sent as the webhook
 * `token` (the HMAC key) unless `create`/`update` pass an explicit `token`.
 */
export function webhooksResource(http: Http, defaultToken?: string): WebhooksResource {
  return {
    create(input) {
      return http.post<CompanyCamWebhook>("webhooks", {
        url: input.url,
        scopes: input.scopes,
        enabled: input.enabled ?? true,
        token: input.token ?? defaultToken,
      })
    },
    list(options) {
      return http.get<CompanyCamWebhook[]>("webhooks", pageParams(options))
    },
    get(id) {
      return http.get<CompanyCamWebhook>(`webhooks/${id}`)
    },
    update(id, input) {
      return http.put<CompanyCamWebhook>(`webhooks/${id}`, {
        url: input.url,
        scopes: input.scopes,
        enabled: input.enabled,
        token: input.token ?? defaultToken,
      })
    },
    delete(id) {
      return http.delete(`webhooks/${id}`)
    },
  }
}
