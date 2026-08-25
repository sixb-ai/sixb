import type { LinkedinHttp } from "../http"
import {
  type QueryParams,
  restliList,
  restliTimeIntervals,
  restliTimeRange,
  urnPath,
  withQuery,
} from "../restli"
import type { LinkedinOrganizationUrn, LinkedinTimeIntervals } from "../types/common"
import type {
  LinkedinOrganizationFollowerStatistic,
  LinkedinOrganizationPageStatistic,
  LinkedinOrganizationShareStatistic,
  LinkedinOrganizationShareStatisticsQuery,
  LinkedinOrganizationVideoAnalyticsQuery,
  LinkedinOrganizationVideoStatistic,
} from "../types/community-analytics"
import { assertTimeIntervals, assertTimeRange, type ElementsResponse } from "./community-utils"

export interface OrganizationAnalyticsResource {
  /** Lifetime demographic breakdown, or time-bound follower gains. */
  followers(
    organization: LinkedinOrganizationUrn,
    timeIntervals?: LinkedinTimeIntervals
  ): Promise<readonly LinkedinOrganizationFollowerStatistic[]>
  /** Lifetime or time-bound views and clicks for an organization Page. */
  pages(
    organization: LinkedinOrganizationUrn,
    timeIntervals?: LinkedinTimeIntervals
  ): Promise<readonly LinkedinOrganizationPageStatistic[]>
  /** Organic-only share statistics from LinkedIn's rolling 12-month window. */
  shares(
    organization: LinkedinOrganizationUrn,
    query?: LinkedinOrganizationShareStatisticsQuery
  ): Promise<readonly LinkedinOrganizationShareStatistic[]>
  video(
    query: LinkedinOrganizationVideoAnalyticsQuery
  ): Promise<readonly LinkedinOrganizationVideoStatistic[]>
}

export function createOrganizationAnalyticsResource(
  http: LinkedinHttp
): OrganizationAnalyticsResource {
  return {
    followers(organization, timeIntervals) {
      return organizationRows(
        http,
        "organizationalEntityFollowerStatistics",
        "organizationalEntity",
        organization,
        timeIntervals
      )
    },
    pages(organization, timeIntervals) {
      assertSupportedGranularity(timeIntervals, ["DAY", "MONTH"], "Page statistics")
      return organizationRows(
        http,
        "organizationPageStatistics",
        "organization",
        organization,
        timeIntervals
      )
    },
    shares(organization, query) {
      urnPath(organization, "organization URN")
      assertTimeIntervals(query?.timeIntervals)
      assertSupportedGranularity(query?.timeIntervals, ["DAY", "MONTH"], "Share statistics")
      if (query?.timeIntervals && query.posts?.length) {
        return Promise.reject(
          new Error("[SixbLinkedin] specific posts cannot be combined with timeIntervals.")
        )
      }

      const shares = query?.posts?.filter((post) => post.startsWith("urn:li:share:"))
      const ugcPosts = query?.posts?.filter((post) => post.startsWith("urn:li:ugcPost:"))
      query?.posts?.forEach((post) => {
        urnPath(post, "post URN")
      })
      const params: Record<string, QueryParams[string]> = {
        q: "organizationalEntity",
        organizationalEntity: organization,
        timeIntervals: query?.timeIntervals ? restliTimeIntervals(query.timeIntervals) : undefined,
        shares: shares?.length ? restliList(shares) : undefined,
      }
      ugcPosts?.forEach((post, index) => {
        params[`ugcPosts[${index}]`] = post
      })
      return rows<LinkedinOrganizationShareStatistic>(
        http,
        withQuery("organizationalEntityShareStatistics", params)
      )
    },
    video(query) {
      urnPath(query.entity, "video post URN")
      assertTimeRange(query.timeRange)
      return rows<LinkedinOrganizationVideoStatistic>(
        http,
        withQuery("videoAnalytics", {
          q: "entity",
          entity: query.entity,
          type: query.type,
          aggregation: query.aggregation,
          timeRange: query.timeRange ? restliTimeRange(query.timeRange) : undefined,
        })
      )
    },
  }
}

async function organizationRows<TItem>(
  http: LinkedinHttp,
  path: string,
  organizationField: "organizationalEntity" | "organization",
  organization: LinkedinOrganizationUrn,
  timeIntervals: LinkedinTimeIntervals | undefined
): Promise<readonly TItem[]> {
  urnPath(organization, "organization URN")
  assertTimeIntervals(timeIntervals)
  return rows<TItem>(
    http,
    withQuery(path, {
      q: organizationField,
      [organizationField]: organization,
      timeIntervals: timeIntervals ? restliTimeIntervals(timeIntervals) : undefined,
    })
  )
}

async function rows<TItem>(http: LinkedinHttp, path: string): Promise<readonly TItem[]> {
  const response = await http.get<ElementsResponse<TItem>>(path)
  return response.elements ?? []
}

function assertSupportedGranularity(
  value: LinkedinTimeIntervals | undefined,
  supported: readonly LinkedinTimeIntervals["timeGranularityType"][],
  resource: string
): void {
  if (value && !supported.includes(value.timeGranularityType)) {
    throw new Error(
      `[SixbLinkedin] ${resource} supports ${supported.join(" or ")} granularity only.`
    )
  }
}
