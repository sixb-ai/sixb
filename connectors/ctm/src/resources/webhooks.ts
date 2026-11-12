import type { CtmHttp } from "../http"
import type {
  CtmChangeNotification,
  CtmChangeNotificationInput,
  CtmChangeNotificationResult,
  CtmId,
  CtmObject,
  CtmWebhook,
  CtmWebhookCreateResult,
  CtmWebhookInput,
} from "../types"
import { assertNonEmpty, pathId } from "../validation"
import {
  type CtmAccountPath,
  type CtmListMethods,
  type CtmReadMethods,
  listMethods,
  readMethods,
} from "./shared"

/**
 * CTM's outbound webhooks: one URL and one trigger each. Point them at the connector's `events`
 * route with `hooktype: "call"` and the `webhookAuth` username and password.
 */
export interface WebhooksResource extends CtmReadMethods<CtmWebhook> {
  /** `POST /webhooks` */
  create(input: CtmWebhookInput): Promise<CtmWebhookCreateResult>
  /** `PUT /webhooks/{id}` */
  update(webhookId: CtmId, input: CtmWebhookInput): Promise<CtmObject>
  /** `DELETE /webhooks/{id}` */
  delete(webhookId: CtmId): Promise<CtmObject>
}

export function webhooksResource(http: CtmHttp, at: CtmAccountPath): WebhooksResource {
  const webhook = (webhookId: CtmId) => at(`webhooks/${pathId(webhookId, "webhookId")}`)

  return {
    ...readMethods<CtmWebhook>(http, at, "webhooks", "webhooks", "webhookId"),

    async create(input) {
      assertNonEmpty(input.weburl, "weburl")

      return http.post<CtmWebhookCreateResult>(at("webhooks"), input)
    },

    async update(webhookId, input) {
      assertNonEmpty(input.weburl, "weburl")

      return http.put<CtmObject>(webhook(webhookId), input)
    },

    async delete(webhookId) {
      return http.delete<CtmObject>(webhook(webhookId))
    },
  }
}

/** Notifications of configuration changes, such as a tracking number being edited. */
export interface ChangeNotificationsResource extends CtmListMethods<CtmChangeNotification> {
  /** `POST /change_notifications` */
  create(input: CtmChangeNotificationInput): Promise<CtmChangeNotificationResult>
  /** `DELETE /change_notifications/{id}` */
  delete(changeNotificationId: CtmId): Promise<CtmChangeNotificationResult>
}

export function changeNotificationsResource(
  http: CtmHttp,
  at: CtmAccountPath
): ChangeNotificationsResource {
  return {
    ...listMethods<CtmChangeNotification>(
      http,
      () => at("change_notifications"),
      "change_notifications"
    ),

    async create(input) {
      assertNonEmpty(input.name, "name")
      assertNonEmpty(input.deliver_to, "deliver_to")

      if (input.included_data.length === 0) {
        throw new Error("[SixbCtm] included_data must name at least one object type.")
      }

      return http.post<CtmChangeNotificationResult>(at("change_notifications"), {
        change_notification: { ...input, delivery_type: "webhook" },
      })
    },

    async delete(changeNotificationId) {
      const id = pathId(changeNotificationId, "changeNotificationId")

      return http.delete<CtmChangeNotificationResult>(at(`change_notifications/${id}`))
    },
  }
}
