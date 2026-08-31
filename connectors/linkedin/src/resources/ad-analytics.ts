import type { LinkedinHttp } from "../http"
import { restliDateRange, restliList, restliProjection, withQuery } from "../restli"
import type {
  LinkedinAdAnalyticsQuery,
  LinkedinAdAnalyticsRow,
  LinkedinAdStatisticsQuery,
  LinkedinAttributedRevenueQuery,
} from "../types/analytics"

export interface AdAnalyticsResource {
  /** `GET /adAnalytics?q=analytics` — one pivot. */
  analytics<TRow extends LinkedinAdAnalyticsRow = LinkedinAdAnalyticsRow>(
    query: LinkedinAdAnalyticsQuery
  ): Promise<readonly TRow[]>
  /** `GET /adAnalytics?q=statistics` — one to three pivots. */
  statistics<TRow extends LinkedinAdAnalyticsRow = LinkedinAdAnalyticsRow>(
    query: LinkedinAdStatisticsQuery
  ): Promise<readonly TRow[]>
  /** `GET /adAnalytics?q=attributedRevenueMetrics`. */
  attributedRevenue<TRow extends LinkedinAdAnalyticsRow = LinkedinAdAnalyticsRow>(
    query: LinkedinAttributedRevenueQuery
  ): Promise<readonly TRow[]>
}

interface AnalyticsResponse<TRow> {
  readonly elements?: readonly TRow[]
}

export function createAdAnalyticsResource(http: LinkedinHttp): AdAnalyticsResource {
  return {
    analytics(query) {
      assertCommonQuery(query)
      return fetchRows(
        http,
        withQuery("adAnalytics", {
          q: "analytics",
          pivot: query.pivot,
          dateRange: restliDateRange(query.dateRange),
          timeGranularity: query.timeGranularity,
          fields: restliProjection(query.fields),
          campaignType: query.campaignType,
          shares: list(query.shares),
          campaigns: list(query.campaigns),
          campaignGroups: list(query.campaignGroups),
          accounts: list(query.accounts),
          companies: list(query.companies),
          "sortBy.field": query.sortBy?.field,
          "sortBy.order": query.sortBy?.order,
        })
      )
    },
    statistics(query) {
      assertCommonQuery(query)
      if (query.pivots.length < 1 || query.pivots.length > 3) {
        return Promise.reject(new Error("[SixbLinkedin] statistics requires one to three pivots."))
      }
      return fetchRows(
        http,
        withQuery("adAnalytics", {
          q: "statistics",
          pivots: restliList(query.pivots),
          dateRange: restliDateRange(query.dateRange),
          timeGranularity: query.timeGranularity,
          fields: restliProjection(query.fields),
          objectiveType: query.objectiveType,
          campaignType: query.campaignType,
          shares: list(query.shares),
          campaigns: list(query.campaigns),
          campaignGroups: list(query.campaignGroups),
          accounts: list(query.accounts),
          companies: list(query.companies),
          "sortBy.field": query.sortBy?.field,
          "sortBy.order": query.sortBy?.order,
        })
      )
    },
    attributedRevenue(query) {
      assertFields(query.fields)
      assertDateRange(query.dateRange)
      if (query.pivots.length < 1 || query.pivots.length > 3) {
        return Promise.reject(
          new Error("[SixbLinkedin] attributed revenue requires one to three pivots.")
        )
      }
      return fetchRows(
        http,
        withQuery("adAnalytics", {
          q: "attributedRevenueMetrics",
          pivots: restliList(query.pivots),
          account: restliList([query.account]),
          dateRange: restliDateRange(query.dateRange),
          fields: restliProjection(query.fields),
          campaigns: list(query.campaigns),
          campaignGroups: list(query.campaignGroups),
        })
      )
    },
  }
}

async function fetchRows<TRow extends LinkedinAdAnalyticsRow>(
  http: LinkedinHttp,
  path: string
): Promise<readonly TRow[]> {
  const response = await http.get<AnalyticsResponse<TRow>>(path)
  return response.elements ?? []
}

function assertCommonQuery(query: LinkedinAdAnalyticsQuery | LinkedinAdStatisticsQuery): void {
  assertFields(query.fields)
  assertDateRange(query.dateRange)
  if (
    !query.shares?.length &&
    !query.campaigns?.length &&
    !query.campaignGroups?.length &&
    !query.accounts?.length &&
    !query.companies?.length
  ) {
    throw new Error("[SixbLinkedin] ad analytics requires at least one entity facet.")
  }
}

function assertFields(fields: readonly string[]): void {
  if (fields.length < 1 || fields.length > 20 || fields.some((field) => !field.trim())) {
    throw new Error("[SixbLinkedin] ad analytics fields must contain between 1 and 20 names.")
  }
}

function assertDateRange(range: LinkedinAdAnalyticsQuery["dateRange"]): void {
  const start = utcDate(range.start)
  const end = range.end ? utcDate(range.end) : undefined
  if (end !== undefined && start > end) {
    throw new Error("[SixbLinkedin] dateRange.start must not be after dateRange.end.")
  }
}

function utcDate(date: LinkedinAdAnalyticsQuery["dateRange"]["start"]): number {
  const timestamp = Date.UTC(date.year, date.month - 1, date.day)
  const resolved = new Date(timestamp)
  if (
    !Number.isInteger(date.year) ||
    !Number.isInteger(date.month) ||
    !Number.isInteger(date.day) ||
    resolved.getUTCFullYear() !== date.year ||
    resolved.getUTCMonth() + 1 !== date.month ||
    resolved.getUTCDate() !== date.day
  ) {
    throw new Error("[SixbLinkedin] ad analytics dateRange contains an invalid UTC date.")
  }
  return timestamp
}

function list(values: readonly string[] | undefined) {
  return values?.length ? restliList(values) : undefined
}
