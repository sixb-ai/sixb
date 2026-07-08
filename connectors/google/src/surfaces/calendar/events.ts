import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  Channel,
  Event,
  EventDeleteOptions,
  EventGetOptions,
  EventImportOptions,
  EventInstancesOptions,
  EventList,
  EventMoveOptions,
  EventQuickAddOptions,
  EventsListOptions,
  EventsWatchOptions,
  EventWriteOptions,
} from "../../types/calendar"

function eventsPath(calendarId: string, suffix = ""): string {
  return `calendars/${pathSegment(calendarId, "calendarId")}/events${suffix}`
}

function eventPath(calendarId: string, eventId: string, suffix = ""): string {
  return `${eventsPath(calendarId)}/${pathSegment(eventId, "eventId")}${suffix}`
}

export interface EventsResource {
  /** `GET /calendars/{calendarId}/events` — one page of events. */
  list(calendarId: string, options?: EventsListOptions): Promise<EventList>
  /**
   * Iterate every event across all pages. Call `list` directly when you need
   * `nextSyncToken` (only present on the final page) to poll incrementally.
   */
  listAll(calendarId: string, options?: EventsListOptions): AsyncIterable<Event>
  /** `GET /calendars/{calendarId}/events/{eventId}`. */
  get(calendarId: string, eventId: string, options?: EventGetOptions): Promise<Event>
  /** `POST /calendars/{calendarId}/events`. */
  insert(calendarId: string, event: Event, options?: EventWriteOptions): Promise<Event>
  /** `PUT /calendars/{calendarId}/events/{eventId}` — full replacement. */
  update(
    calendarId: string,
    eventId: string,
    event: Event,
    options?: EventWriteOptions
  ): Promise<Event>
  /** `PATCH /calendars/{calendarId}/events/{eventId}` — partial update. */
  patch(
    calendarId: string,
    eventId: string,
    event: Partial<Event>,
    options?: EventWriteOptions
  ): Promise<Event>
  /** `DELETE /calendars/{calendarId}/events/{eventId}`. */
  delete(calendarId: string, eventId: string, options?: EventDeleteOptions): Promise<void>
  /** `POST /calendars/{calendarId}/events/import` — import a copy of an existing event. */
  import(calendarId: string, event: Event, options?: EventImportOptions): Promise<Event>
  /** `GET /calendars/{calendarId}/events/{eventId}/instances` — one page of instances. */
  instances(
    calendarId: string,
    eventId: string,
    options?: EventInstancesOptions
  ): Promise<EventList>
  /** Iterate every instance of a recurring event across all pages. */
  instancesAll(
    calendarId: string,
    eventId: string,
    options?: EventInstancesOptions
  ): AsyncIterable<Event>
  /** `POST /calendars/{calendarId}/events/{eventId}/move` — move to `options.destination`. */
  move(calendarId: string, eventId: string, options: EventMoveOptions): Promise<Event>
  /** `POST /calendars/{calendarId}/events/quickAdd` — create from `options.text`. */
  quickAdd(calendarId: string, options: EventQuickAddOptions): Promise<Event>
  /** `POST /calendars/{calendarId}/events/watch` — open a push-notification channel. */
  watch(calendarId: string, channel: Channel, options?: EventsWatchOptions): Promise<Channel>
}

export function eventsResource(http: GoogleHttp): EventsResource {
  const resource: EventsResource = {
    list(calendarId, options) {
      return http.json<EventList>("calendar", "GET", eventsPath(calendarId), { query: options })
    },
    listAll(calendarId, options) {
      return listAllPages<EventList, Event>(
        (pageToken) => resource.list(calendarId, { ...options, pageToken }),
        (page) => page.items,
        options?.pageToken
      )
    },
    get(calendarId, eventId, options) {
      return http.json<Event>("calendar", "GET", eventPath(calendarId, eventId), { query: options })
    },
    insert(calendarId, event, options) {
      return http.json<Event>("calendar", "POST", eventsPath(calendarId), {
        query: options,
        body: event,
      })
    },
    update(calendarId, eventId, event, options) {
      return http.json<Event>("calendar", "PUT", eventPath(calendarId, eventId), {
        query: options,
        body: event,
      })
    },
    patch(calendarId, eventId, event, options) {
      return http.json<Event>("calendar", "PATCH", eventPath(calendarId, eventId), {
        query: options,
        body: event,
      })
    },
    delete(calendarId, eventId, options) {
      return http.json<void>("calendar", "DELETE", eventPath(calendarId, eventId), {
        query: options,
      })
    },
    import(calendarId, event, options) {
      return http.json<Event>("calendar", "POST", eventsPath(calendarId, "/import"), {
        query: options,
        body: event,
      })
    },
    instances(calendarId, eventId, options) {
      return http.json<EventList>("calendar", "GET", eventPath(calendarId, eventId, "/instances"), {
        query: options,
      })
    },
    instancesAll(calendarId, eventId, options) {
      return listAllPages<EventList, Event>(
        (pageToken) => resource.instances(calendarId, eventId, { ...options, pageToken }),
        (page) => page.items,
        options?.pageToken
      )
    },
    move(calendarId, eventId, options) {
      return http.json<Event>("calendar", "POST", eventPath(calendarId, eventId, "/move"), {
        query: options,
      })
    },
    quickAdd(calendarId, options) {
      return http.json<Event>("calendar", "POST", eventsPath(calendarId, "/quickAdd"), {
        query: options,
      })
    },
    watch(calendarId, channel, options) {
      return http.json<Channel>("calendar", "POST", eventsPath(calendarId, "/watch"), {
        query: options,
        body: channel,
      })
    },
  }

  return resource
}
