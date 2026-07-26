import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type { MercuryEvent, MercuryEventListOptions, MercuryEventsResponse } from "../types"
import { assertCursorOptions, pathId } from "../validation"

/**
 * Mercury's audit stream. This is the polling counterpart to webhooks: page forward from the last
 * event id you processed to pick up every change since, without exposing an inbound HTTP route.
 */
export interface EventsResource {
  /** `GET /events` */
  list(options?: MercuryEventListOptions): Promise<MercuryEventsResponse>
  /** Cursor iterator over `GET /events`. */
  listAll(options?: MercuryEventListOptions): AsyncIterable<MercuryEvent>
  /** `GET /events/{eventId}` */
  get(eventId: string): Promise<MercuryEvent>
}

export function createEventsResource(http: MercuryHttp): EventsResource {
  const resource: EventsResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("events", {
        ...cursorQuery(options),
        resourceType: options?.resourceType,
        resourceId: options?.resourceId,
      })
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.events, options)
    },
    get(eventId) {
      return http.get(`events/${pathId(eventId, "event id")}`)
    },
  }

  return resource
}
