import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsGoogleAdsLink,
  AnalyticsGoogleAdsLinkListOptions,
  AnalyticsListGoogleAdsLinksResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { childResourceName, propertyName } from "../paths"

export interface AnalyticsGoogleAdsLinksResource {
  list(
    parent: string,
    options?: AnalyticsGoogleAdsLinkListOptions
  ): Promise<AnalyticsListGoogleAdsLinksResponse>
  listAll(
    parent: string,
    options?: AnalyticsGoogleAdsLinkListOptions
  ): AsyncIterable<AnalyticsGoogleAdsLink>
  create(parent: string, link: AnalyticsGoogleAdsLink): Promise<AnalyticsGoogleAdsLink>
  patch(
    name: string,
    link: Partial<AnalyticsGoogleAdsLink>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsGoogleAdsLink>
  delete(name: string): Promise<void>
}

export function analyticsGoogleAdsLinksResource(http: GoogleHttp): AnalyticsGoogleAdsLinksResource {
  const resource: AnalyticsGoogleAdsLinksResource = {
    list(parent, options) {
      return http.json(
        "analyticsAdmin",
        "GET",
        `${propertyName(parent, "parent")}/googleAdsLinks`,
        { query: options }
      )
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.googleAdsLinks,
        options?.pageToken
      )
    },
    create(parent, link) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${propertyName(parent, "parent")}/googleAdsLinks`,
        { body: link }
      )
    },
    patch(name, link, options) {
      const path = childResourceName(name, "googleAdsLinks")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...link, name },
      })
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", childResourceName(name, "googleAdsLinks"))
    },
  }
  return resource
}
