import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsKeyEvent,
  AnalyticsKeyEventListOptions,
  AnalyticsListKeyEventsResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { childResourceName, propertyName } from "../paths"

export interface AnalyticsKeyEventsResource {
  list(
    parent: string,
    options?: AnalyticsKeyEventListOptions
  ): Promise<AnalyticsListKeyEventsResponse>
  listAll(parent: string, options?: AnalyticsKeyEventListOptions): AsyncIterable<AnalyticsKeyEvent>
  get(name: string): Promise<AnalyticsKeyEvent>
  create(parent: string, event: AnalyticsKeyEvent): Promise<AnalyticsKeyEvent>
  patch(
    name: string,
    event: Partial<AnalyticsKeyEvent>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsKeyEvent>
  delete(name: string): Promise<void>
}

export function analyticsKeyEventsResource(http: GoogleHttp): AnalyticsKeyEventsResource {
  const resource: AnalyticsKeyEventsResource = {
    list(parent, options) {
      return http.json("analyticsAdmin", "GET", `${propertyName(parent, "parent")}/keyEvents`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.keyEvents,
        options?.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", childResourceName(name, "keyEvents"))
    },
    create(parent, event) {
      return http.json("analyticsAdmin", "POST", `${propertyName(parent, "parent")}/keyEvents`, {
        body: event,
      })
    },
    patch(name, event, options) {
      const path = childResourceName(name, "keyEvents")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...event, name },
      })
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", childResourceName(name, "keyEvents"))
    },
  }
  return resource
}
