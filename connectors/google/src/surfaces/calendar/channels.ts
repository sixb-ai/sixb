import type { GoogleHttp } from "../../http"
import type { Channel } from "../../types/calendar"

export interface ChannelsResource {
  /**
   * `POST /channels/stop` — stop a push-notification channel opened by any
   * `watch` method. Pass back the `id` and `resourceId` from the watch response.
   */
  stop(channel: Channel): Promise<void>
}

export function channelsResource(http: GoogleHttp): ChannelsResource {
  return {
    stop(channel) {
      return http.json<void>("calendar", "POST", "channels/stop", { body: channel })
    },
  }
}
