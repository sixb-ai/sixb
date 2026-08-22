import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsFirebaseLink,
  AnalyticsFirebaseLinkListOptions,
  AnalyticsListFirebaseLinksResponse,
} from "../../../types/analytics-admin"
import { childResourceName, propertyName } from "../paths"

export interface AnalyticsFirebaseLinksResource {
  list(
    parent: string,
    options?: AnalyticsFirebaseLinkListOptions
  ): Promise<AnalyticsListFirebaseLinksResponse>
  listAll(
    parent: string,
    options?: AnalyticsFirebaseLinkListOptions
  ): AsyncIterable<AnalyticsFirebaseLink>
  create(parent: string, link: AnalyticsFirebaseLink): Promise<AnalyticsFirebaseLink>
  delete(name: string): Promise<void>
}

export function analyticsFirebaseLinksResource(http: GoogleHttp): AnalyticsFirebaseLinksResource {
  const resource: AnalyticsFirebaseLinksResource = {
    list(parent, options) {
      return http.json("analyticsAdmin", "GET", `${propertyName(parent, "parent")}/firebaseLinks`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.firebaseLinks,
        options?.pageToken
      )
    },
    create(parent, link) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${propertyName(parent, "parent")}/firebaseLinks`,
        { body: link }
      )
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", childResourceName(name, "firebaseLinks"))
    },
  }
  return resource
}
