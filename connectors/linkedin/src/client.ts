import type { LinkedinHttp } from "./http"
import { createAdAccountUsersResource } from "./resources/ad-account-users"
import { createAdAccountsResource } from "./resources/ad-accounts"
import { createAdAnalyticsResource } from "./resources/ad-analytics"
import { createCampaignGroupsResource } from "./resources/campaign-groups"
import { createCampaignsResource } from "./resources/campaigns"
import { createCommentsResource } from "./resources/comments"
import { createCreativesResource } from "./resources/creatives"
import {
  createDocumentsResource,
  createImagesResource,
  createVideosResource,
} from "./resources/media"
import { createMemberAnalyticsResource } from "./resources/member-analytics"
import { createOrganizationAclsResource } from "./resources/organization-acls"
import { createOrganizationAnalyticsResource } from "./resources/organization-analytics"
import { createOrganizationsResource } from "./resources/organizations"
import { createPostsResource } from "./resources/posts"
import { createReactionsResource } from "./resources/reactions"
import { createSocialMetadataResource } from "./resources/social-metadata"
import { pathId } from "./restli"
import type { LinkedinClient } from "./types/client"

export function createLinkedinClient(http: LinkedinHttp): LinkedinClient {
  return {
    adAccounts: createAdAccountsResource(http),
    adAccountUsers: createAdAccountUsersResource(http),
    adAnalytics: createAdAnalyticsResource(http),
    organizationAcls: createOrganizationAclsResource(http),
    organizations: createOrganizationsResource(http),
    posts: createPostsResource(http),
    socialMetadata: createSocialMetadataResource(http),
    comments: createCommentsResource(http),
    reactions: createReactionsResource(http),
    organizationAnalytics: createOrganizationAnalyticsResource(http),
    memberAnalytics: createMemberAnalyticsResource(http),
    images: createImagesResource(http),
    videos: createVideosResource(http),
    documents: createDocumentsResource(http),
    adAccount(id) {
      const accountId = pathId(id, "ad account id")
      return {
        campaignGroups: createCampaignGroupsResource(http, accountId),
        campaigns: createCampaignsResource(http, accountId),
        creatives: createCreativesResource(http, accountId),
      }
    },
  }
}
