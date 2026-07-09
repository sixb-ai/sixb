import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  CalendarList,
  CalendarListEntry,
  CalendarListGetOptions,
  CalendarListInsertOptions,
  CalendarListListOptions,
  CalendarListUpdateOptions,
  CalendarListWatchOptions,
  Channel,
} from "../../types/calendar"

const BASE = "users/me/calendarList"

function entryPath(calendarId: string): string {
  return `${BASE}/${pathSegment(calendarId, "calendarId")}`
}

export interface CalendarListResource {
  /** `GET /users/me/calendarList` — one page of the user's calendar list. */
  list(options?: CalendarListListOptions): Promise<CalendarList>
  /**
   * Iterate every calendar-list entry across all pages. Call `list` directly
   * when you need `nextSyncToken` (only on the final page) for incremental sync.
   */
  listAll(options?: CalendarListListOptions): AsyncIterable<CalendarListEntry>
  /** `GET /users/me/calendarList/{calendarId}`. */
  get(calendarId: string, options?: CalendarListGetOptions): Promise<CalendarListEntry>
  /** `POST /users/me/calendarList` — add an existing calendar to the user's list. */
  insert(entry: CalendarListEntry, options?: CalendarListInsertOptions): Promise<CalendarListEntry>
  /** `PUT /users/me/calendarList/{calendarId}` — full replacement. */
  update(
    calendarId: string,
    entry: CalendarListEntry,
    options?: CalendarListUpdateOptions
  ): Promise<CalendarListEntry>
  /** `PATCH /users/me/calendarList/{calendarId}` — partial update. */
  patch(
    calendarId: string,
    entry: Partial<CalendarListEntry>,
    options?: CalendarListUpdateOptions
  ): Promise<CalendarListEntry>
  /** `DELETE /users/me/calendarList/{calendarId}`. */
  delete(calendarId: string): Promise<void>
  /** `POST /users/me/calendarList/watch` — open a push-notification channel. */
  watch(channel: Channel, options?: CalendarListWatchOptions): Promise<Channel>
}

export function calendarListResource(http: GoogleHttp): CalendarListResource {
  const resource: CalendarListResource = {
    list(options) {
      return http.json<CalendarList>("calendar", "GET", BASE, { query: options })
    },
    listAll(options) {
      return listAllPages<CalendarList, CalendarListEntry>(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.items,
        options?.pageToken
      )
    },
    get(calendarId, options) {
      return http.json<CalendarListEntry>("calendar", "GET", entryPath(calendarId), {
        query: options,
      })
    },
    insert(entry, options) {
      return http.json<CalendarListEntry>("calendar", "POST", BASE, {
        query: options,
        body: entry,
      })
    },
    update(calendarId, entry, options) {
      return http.json<CalendarListEntry>("calendar", "PUT", entryPath(calendarId), {
        query: options,
        body: entry,
      })
    },
    patch(calendarId, entry, options) {
      return http.json<CalendarListEntry>("calendar", "PATCH", entryPath(calendarId), {
        query: options,
        body: entry,
      })
    },
    delete(calendarId) {
      return http.json<void>("calendar", "DELETE", entryPath(calendarId))
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
