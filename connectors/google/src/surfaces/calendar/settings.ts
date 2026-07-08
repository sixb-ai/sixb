import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  Channel,
  Setting,
  SettingsList,
  SettingsListOptions,
  SettingsWatchOptions,
} from "../../types/calendar"

const BASE = "users/me/settings"

export interface SettingsResource {
  /** `GET /users/me/settings` — one page of the user's calendar settings. */
  list(options?: SettingsListOptions): Promise<SettingsList>
  /** Iterate every setting across all pages. */
  listAll(options?: SettingsListOptions): AsyncIterable<Setting>
  /** `GET /users/me/settings/{setting}` — a single setting (e.g. `timezone`). */
  get(setting: string): Promise<Setting>
  /** `POST /users/me/settings/watch` — open a push-notification channel. */
  watch(channel: Channel, options?: SettingsWatchOptions): Promise<Channel>
}

export function settingsResource(http: GoogleHttp): SettingsResource {
  const resource: SettingsResource = {
    list(options) {
      return http.json<SettingsList>("calendar", "GET", BASE, { query: options })
    },
    listAll(options) {
      return listAllPages<SettingsList, Setting>(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.items,
        options?.pageToken
      )
    },
    get(setting) {
      return http.json<Setting>("calendar", "GET", `${BASE}/${pathSegment(setting, "setting")}`)
    },
    watch(channel, options) {
      return http.json<Channel>("calendar", "POST", `${BASE}/watch`, {
        query: options,
        body: channel,
      })
    },
  }

  return resource
}
