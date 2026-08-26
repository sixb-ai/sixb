import type {
  TiktokAdAccountApi,
  TiktokAdGroupsApi,
  TiktokAdsApi,
  TiktokCampaignsApi,
  TiktokReportsApi,
} from "./ads"
import type { TiktokConnectedAccount } from "./common"
import type {
  TiktokOrganicCommentsApi,
  TiktokOrganicPostsApi,
  TiktokOrganicProfileApi,
} from "./organic"

export interface TiktokOrganicClient {
  readonly account: TiktokConnectedAccount<"organic-account">
  readonly profile: TiktokOrganicProfileApi
  readonly posts: TiktokOrganicPostsApi
  readonly comments: TiktokOrganicCommentsApi
}

export interface TiktokAdsClient {
  readonly account: TiktokConnectedAccount<"ad-account">
  readonly adAccount: TiktokAdAccountApi
  readonly campaigns: TiktokCampaignsApi
  readonly adGroups: TiktokAdGroupsApi
  readonly ads: TiktokAdsApi
  readonly reports: TiktokReportsApi
}

export type TiktokClient = TiktokOrganicClient | TiktokAdsClient
