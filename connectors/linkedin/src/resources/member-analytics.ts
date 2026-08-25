import type { LinkedinHttp } from "../http"
import { restliOptionalDateRange, restliPostEntity, withQuery } from "../restli"
import type { LinkedinOptionalDateRange } from "../types/common"
import type {
  LinkedinMemberFollowerStatistic,
  LinkedinMemberPostAnalyticsQuery,
  LinkedinMemberPostEntityAnalyticsQuery,
  LinkedinMemberPostMetric,
  LinkedinMemberPostStatistic,
  LinkedinMemberVideoAnalyticsQuery,
  LinkedinMemberVideoStatistic,
} from "../types/community-analytics"
import { assertOptionalDateRange, type ElementsResponse } from "./community-utils"

export interface MemberAnalyticsResource {
  /** Lifetime follower count for the authenticated member. */
  followers(): Promise<readonly LinkedinMemberFollowerStatistic[]>
  /** Daily follower count for the authenticated member. */
  followerHistory(
    dateRange?: LinkedinOptionalDateRange
  ): Promise<readonly LinkedinMemberFollowerStatistic[]>
  post(
    query: LinkedinMemberPostEntityAnalyticsQuery
  ): Promise<readonly LinkedinMemberPostStatistic[]>
  /** Aggregated analytics across the authenticated member's posts. */
  posts(query: LinkedinMemberPostAnalyticsQuery): Promise<readonly LinkedinMemberPostStatistic[]>
  video(query: LinkedinMemberVideoAnalyticsQuery): Promise<readonly LinkedinMemberVideoStatistic[]>
}

export function createMemberAnalyticsResource(http: LinkedinHttp): MemberAnalyticsResource {
  return {
    followers() {
      return rows(http, withQuery("memberFollowersCount", { q: "me" }))
    },
    followerHistory(dateRange) {
      assertOptionalDateRange(dateRange)
      return rows(
        http,
        withQuery("memberFollowersCount", {
          q: "dateRange",
          dateRange: dateRange ? restliOptionalDateRange(dateRange) : undefined,
        })
      )
    },
    post(query) {
      assertMemberPostQuery(query, true)
      return rows(
        http,
        withQuery("memberCreatorPostAnalytics", {
          q: "entity",
          entity: restliPostEntity(query.entity),
          queryType: query.queryType,
          aggregation: query.aggregation,
          dateRange: query.dateRange ? restliOptionalDateRange(query.dateRange) : undefined,
        })
      )
    },
    posts(query) {
      assertMemberPostQuery(query, false)
      return rows(
        http,
        withQuery("memberCreatorPostAnalytics", {
          q: "me",
          queryType: query.queryType,
          aggregation: query.aggregation,
          dateRange: query.dateRange ? restliOptionalDateRange(query.dateRange) : undefined,
        })
      )
    },
    video(query) {
      assertOptionalDateRange(query.dateRange)
      return rows(
        http,
        withQuery("memberCreatorVideoAnalytics", {
          q: "entity",
          entity: restliPostEntity(query.entity),
          queryType: query.queryType,
          aggregation: query.aggregation,
          dateRange: query.dateRange ? restliOptionalDateRange(query.dateRange) : undefined,
        })
      )
    },
  }
}

async function rows<TItem>(http: LinkedinHttp, path: string): Promise<readonly TItem[]> {
  const response = await http.get<ElementsResponse<TItem>>(path)
  return response.elements ?? []
}

const ENTITY_DAILY_UNSUPPORTED = new Set<LinkedinMemberPostMetric>([
  "IMPRESSION",
  "MEMBERS_REACHED",
  "LINK_CLICKS",
  "FOLLOWER_GAINED_FROM_CONTENT",
  "PROFILE_VIEW_FROM_CONTENT",
])

const AGGREGATE_DAILY_UNSUPPORTED = new Set<LinkedinMemberPostMetric>([
  "MEMBERS_REACHED",
  "LINK_CLICKS",
  "FOLLOWER_GAINED_FROM_CONTENT",
  "PROFILE_VIEW_FROM_CONTENT",
])

function assertMemberPostQuery(query: LinkedinMemberPostAnalyticsQuery, entity: boolean): void {
  assertOptionalDateRange(query.dateRange)
  const unsupported = entity ? ENTITY_DAILY_UNSUPPORTED : AGGREGATE_DAILY_UNSUPPORTED
  if (query.aggregation === "DAILY" && unsupported.has(query.queryType)) {
    throw new Error(
      `[SixbLinkedin] ${query.queryType} does not support DAILY member post aggregation.`
    )
  }
}
