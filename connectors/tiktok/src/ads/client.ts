import type { TiktokHttp } from "../http"
import type { TiktokAdsClient } from "../types/client"
import type { TiktokConnectedAccount } from "../types/common"
import {
  createAdAccountApi,
  createAdGroupsApi,
  createAdsApi,
  createCampaignsApi,
  createReportsApi,
} from "./resources"

export function createAdsClient(
  http: TiktokHttp,
  account: TiktokConnectedAccount<"ad-account">
): TiktokAdsClient {
  return {
    account,
    adAccount: createAdAccountApi(http, account.id),
    campaigns: createCampaignsApi(http, account.id),
    adGroups: createAdGroupsApi(http, account.id),
    ads: createAdsApi(http, account.id),
    reports: createReportsApi(http, account.id),
  }
}
