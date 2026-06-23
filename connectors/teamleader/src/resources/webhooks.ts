import type { TeamleaderRequester } from "../http"
import type {
  TeamleaderClient,
  TeamleaderListResponse,
  TeamleaderWebhookRegistration,
} from "../types"

export function createWebhooksResource(request: TeamleaderRequester): TeamleaderClient["webhooks"] {
  return {
    list(requestOptions) {
      return request<TeamleaderListResponse<TeamleaderWebhookRegistration>>(
        "/webhooks.list",
        undefined,
        requestOptions
      )
    },
    register(body, requestOptions) {
      return request<void>("/webhooks.register", body, requestOptions)
    },
    unregister(body, requestOptions) {
      return request<void>("/webhooks.unregister", body, requestOptions)
    },
  }
}
