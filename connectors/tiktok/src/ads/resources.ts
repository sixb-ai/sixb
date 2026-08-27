import { assertNonEmpty, assertPositiveIntegerInRange, type TiktokHttp } from "../http"
import { paginateNumbered } from "../pagination"
import type {
  TiktokAd,
  TiktokAdAccountApi,
  TiktokAdGroup,
  TiktokAdGroupsApi,
  TiktokAdGroupsListQuery,
  TiktokAdsApi,
  TiktokAdsListQuery,
  TiktokAdvertiser,
  TiktokAdvertiserField,
  TiktokCampaign,
  TiktokCampaignsApi,
  TiktokCampaignsListQuery,
  TiktokReportPage,
  TiktokReportQuery,
  TiktokReportRow,
  TiktokReportsApi,
} from "../types/ads"
import type { TiktokNumberedPage, TiktokPageInfo } from "../types/common"

interface ListData<T> {
  readonly list?: readonly T[]
  readonly page_info: TiktokPageInfo
}

interface ReportData extends ListData<TiktokReportRow> {
  readonly total_metrics?: TiktokReportPage["totalMetrics"]
}

export function createAdAccountApi(http: TiktokHttp, advertiserId: string): TiktokAdAccountApi {
  return {
    async get(fields?: readonly TiktokAdvertiserField[]) {
      const result = await http.get<{ readonly list?: readonly TiktokAdvertiser[] }>(
        "advertiser/info/",
        {
          advertiser_ids: [advertiserId],
          fields,
        }
      )
      const advertiser = result.data.list?.find((item) => item.advertiser_id === advertiserId)
      if (!advertiser) {
        throw new Error(`[SixbTikTok] Advertiser '${advertiserId}' was not returned by TikTok.`)
      }
      return advertiser
    },
  }
}

export function createCampaignsApi(http: TiktokHttp, advertiserId: string): TiktokCampaignsApi {
  const list = (query: TiktokCampaignsListQuery | undefined, page = query?.page ?? 1) =>
    listEntities<TiktokCampaign>(http, "campaign/get/", advertiserId, query, page)
  return {
    list,
    listAll(query) {
      return paginateNumbered((page) => list(query, page), query?.page)
    },
  }
}

export function createAdGroupsApi(http: TiktokHttp, advertiserId: string): TiktokAdGroupsApi {
  const list = (query: TiktokAdGroupsListQuery | undefined, page = query?.page ?? 1) =>
    listEntities<TiktokAdGroup>(http, "adgroup/get/", advertiserId, query, page)
  return {
    list,
    listAll(query) {
      return paginateNumbered((page) => list(query, page), query?.page)
    },
  }
}

export function createAdsApi(http: TiktokHttp, advertiserId: string): TiktokAdsApi {
  const list = (query: TiktokAdsListQuery | undefined, page = query?.page ?? 1) =>
    listEntities<TiktokAd>(http, "ad/get/", advertiserId, query, page)
  return {
    list,
    listAll(query) {
      return paginateNumbered((page) => list(query, page), query?.page)
    },
  }
}

export function createReportsApi(http: TiktokHttp, advertiserId: string): TiktokReportsApi {
  const run = (query: TiktokReportQuery, page = query.page ?? 1) =>
    runReport(http, advertiserId, query, page)
  return {
    run,
    runAll(query) {
      return paginateNumbered((page) => run(query, page), query.page)
    },
  }
}

async function listEntities<T>(
  http: TiktokHttp,
  path: string,
  advertiserId: string,
  query: TiktokCampaignsListQuery | TiktokAdGroupsListQuery | TiktokAdsListQuery | undefined,
  page: number
): Promise<TiktokNumberedPage<T>> {
  validateNumberedPage(page, query?.pageSize)
  const result = await http.get<ListData<T>>(path, {
    advertiser_id: advertiserId,
    fields: query?.fields,
    exclude_field_types_in_response: query?.excludeFieldTypesInResponse,
    filtering: query?.filtering ? { ...query.filtering } : undefined,
    page,
    page_size: query?.pageSize,
  })
  return {
    items: result.data.list ?? [],
    pageInfo: result.data.page_info,
    requestId: result.requestId,
  }
}

async function runReport(
  http: TiktokHttp,
  advertiserId: string,
  query: TiktokReportQuery,
  page: number
): Promise<TiktokReportPage> {
  assertNonEmpty(query.dataLevel, "dataLevel")
  if (query.dimensions.length === 0) {
    throw new Error("[SixbTikTok] dimensions must contain at least one report dimension.")
  }
  validateNumberedPage(page, query.pageSize)

  const result = await http.get<ReportData>("report/integrated/get/", {
    advertiser_id: advertiserId,
    service_type: query.serviceType,
    report_type: query.reportType,
    data_level: query.dataLevel,
    dimensions: query.dimensions,
    metrics: query.metrics,
    enable_total_metrics: query.enableTotalMetrics,
    start_date: query.startDate,
    end_date: query.endDate,
    query_lifetime: query.queryLifetime,
    order_field: query.orderField,
    order_type: query.orderType,
    filtering: query.filtering,
    page,
    page_size: query.pageSize,
  })
  return {
    items: result.data.list ?? [],
    pageInfo: result.data.page_info,
    totalMetrics: result.data.total_metrics,
    requestId: result.requestId,
  }
}

function validateNumberedPage(page: number, pageSize: number | undefined): void {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("[SixbTikTok] page must be a positive integer.")
  }
  assertPositiveIntegerInRange(pageSize, "pageSize", 1000)
}
