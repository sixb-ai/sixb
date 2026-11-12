import {
  DEFAULT_AD_ACCOUNT_FIELDS,
  DEFAULT_AD_CAMPAIGN_FIELDS,
  DEFAULT_AD_CREATIVE_FIELDS,
  DEFAULT_AD_FIELDS,
  DEFAULT_AD_SET_FIELDS,
  DEFAULT_ADS_INSIGHTS_FIELDS,
  DEFAULT_PENDING_AD_ACCOUNT_FIELDS,
} from "../fields"
import {
  assertNonEmpty,
  type MetaHttpContext,
  nodePath,
  readObject,
  readPage,
  toUnixSeconds,
  withQuery,
} from "../http"
import type {
  MetaAdAccount,
  MetaAdAccountApi,
  MetaAdCreativeListOptions,
  MetaAdObjectListOptions,
  MetaAdsApi,
  MetaAdsInsightsQuery,
  MetaAdsListOptions,
  MetaBusinessAdsApi,
  MetaListEdge,
} from "../types/ads"
import type { MetaPage, MetaPaginationOptions } from "../types/common"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function createAdsApi(context: MetaHttpContext): MetaAdsApi {
  return {
    adAccounts: listEdge(context, "me/adaccounts", (options: MetaAdsListOptions) =>
      fieldsQuery(options, DEFAULT_AD_ACCOUNT_FIELDS)
    ),
    business: (businessId) => createBusinessAdsApi(context, nodePath(businessId, "businessId")),
    account: (adAccountId) => createAdAccountApi(context, adAccountPath(adAccountId)),
  }
}

function createBusinessAdsApi(context: MetaHttpContext, business: string): MetaBusinessAdsApi {
  const accounts = (options: MetaAdsListOptions) => fieldsQuery(options, DEFAULT_AD_ACCOUNT_FIELDS)
  return {
    ownedAdAccounts: listEdge(context, `${business}/owned_ad_accounts`, accounts),
    clientAdAccounts: listEdge(context, `${business}/client_ad_accounts`, accounts),
    pendingClientAdAccounts: listEdge(
      context,
      `${business}/pending_client_ad_accounts`,
      (options: MetaAdsListOptions) => fieldsQuery(options, DEFAULT_PENDING_AD_ACCOUNT_FIELDS)
    ),
  }
}

function createAdAccountApi(context: MetaHttpContext, account: string): MetaAdAccountApi {
  return {
    get: (options) =>
      context.http
        .get(
          withQuery(account, { fields: (options?.fields ?? DEFAULT_AD_ACCOUNT_FIELDS).join(",") })
        )
        .then((response) => readObject(response, (raw: MetaAdAccount) => raw)),
    campaigns: listEdge(context, `${account}/campaigns`, (options: MetaAdObjectListOptions) =>
      adObjectQuery(options, DEFAULT_AD_CAMPAIGN_FIELDS)
    ),
    adSets: listEdge(context, `${account}/adsets`, (options: MetaAdObjectListOptions) =>
      adObjectQuery(options, DEFAULT_AD_SET_FIELDS)
    ),
    ads: listEdge(context, `${account}/ads`, (options: MetaAdObjectListOptions) =>
      adObjectQuery(options, DEFAULT_AD_FIELDS)
    ),
    adCreatives: listEdge(
      context,
      `${account}/adcreatives`,
      (options: MetaAdCreativeListOptions) => ({
        ...fieldsQuery(options, DEFAULT_AD_CREATIVE_FIELDS),
        thumbnail_width: options.thumbnailSize?.width,
        thumbnail_height: options.thumbnailSize?.height,
      })
    ),
    insights: listEdge(context, `${account}/insights`, insightsQuery),
  }
}

/** Build both edge methods from one query builder; every item is returned as Meta sent it. */
function listEdge<TItem, TOptions extends MetaPaginationOptions>(
  context: MetaHttpContext,
  path: string,
  query: (options: TOptions) => Record<string, string | number | undefined>
): MetaListEdge<TItem, TOptions> {
  const fetchPage = async (
    options: TOptions,
    after: string | undefined
  ): Promise<MetaPage<TItem>> => {
    const response = await context.http.get(
      withQuery(path, { ...query(options), limit: options.limit ?? 100, after })
    )
    return readPage(response, (raw: TItem) => raw)
  }
  return {
    list: (options) => fetchPage((options ?? {}) as TOptions, options?.after),
    listAll: (options) => strictPages((after) => fetchPage((options ?? {}) as TOptions, after)),
  }
}

/**
 * Follow every page, failing rather than stopping early: a report silently cut short would
 * under-count spend.
 */
async function* strictPages<TItem>(
  fetchPage: (after: string | undefined) => Promise<MetaPage<TItem>>
): AsyncIterable<TItem> {
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await fetchPage(after)
    yield* page.items
    if (!page.hasMore) return
    if (!page.nextCursor || seen.has(page.nextCursor)) {
      throw new Error("[meta] Meta announced another page without a new cursor.")
    }
    seen.add(page.nextCursor)
    after = page.nextCursor
  }
}

function fieldsQuery(options: MetaAdsListOptions, defaults: readonly string[]) {
  return { fields: (options.fields ?? defaults).join(",") }
}

function adObjectQuery(options: MetaAdObjectListOptions, defaults: readonly string[]) {
  return {
    ...fieldsQuery(options, defaults),
    effective_status: options.effectiveStatus?.length
      ? JSON.stringify(options.effectiveStatus)
      : undefined,
    filtering: options.updatedSince
      ? JSON.stringify([
          {
            field: "updated_time",
            operator: "GREATER_THAN",
            value: toUnixSeconds(options.updatedSince),
          },
        ])
      : undefined,
  }
}

function insightsQuery(query: MetaAdsInsightsQuery) {
  const { since, until } = query.timeRange ?? {}
  if (!since || !until || !ISO_DATE.test(since) || !ISO_DATE.test(until) || since > until) {
    throw new Error("[meta] Ads Insights needs a timeRange of two ordered YYYY-MM-DD dates.")
  }
  return {
    ...fieldsQuery(query, DEFAULT_ADS_INSIGHTS_FIELDS),
    level: query.level,
    time_range: JSON.stringify({ since, until }),
    time_increment: query.timeIncrement,
    breakdowns: query.breakdowns?.length ? query.breakdowns.join(",") : undefined,
    action_breakdowns: query.actionBreakdowns?.length
      ? query.actionBreakdowns.join(",")
      : undefined,
    filtering: query.filtering?.length ? JSON.stringify(query.filtering) : undefined,
  }
}

/** `act_123` and `123` both address the ad account node `act_123`. */
function adAccountPath(adAccountId: string): string {
  assertNonEmpty(adAccountId, "adAccountId")
  const id = adAccountId.trim().replace(/^act_/, "")
  if (!/^\d+$/.test(id)) {
    throw new Error(`[meta] adAccountId must be act_<digits> or digits, got '${adAccountId}'.`)
  }
  return `act_${id}`
}
