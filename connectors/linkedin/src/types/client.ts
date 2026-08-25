import type { AdAccountUsersResource } from "../resources/ad-account-users"
import type { AdAccountsResource } from "../resources/ad-accounts"
import type { AdAnalyticsResource } from "../resources/ad-analytics"
import type { CampaignGroupsResource } from "../resources/campaign-groups"
import type { CampaignsResource } from "../resources/campaigns"
import type { CommentsResource } from "../resources/comments"
import type { CreativesResource } from "../resources/creatives"
import type { DocumentsResource, ImagesResource, VideosResource } from "../resources/media"
import type { MemberAnalyticsResource } from "../resources/member-analytics"
import type { OrganizationAclsResource } from "../resources/organization-acls"
import type { OrganizationAnalyticsResource } from "../resources/organization-analytics"
import type { OrganizationsResource } from "../resources/organizations"
import type { PostsResource } from "../resources/posts"
import type { ReactionsResource } from "../resources/reactions"
import type { SocialMetadataResource } from "../resources/social-metadata"
import type { LinkedinId } from "./common"

export interface LinkedinAdAccountClient {
  readonly campaignGroups: CampaignGroupsResource
  readonly campaigns: CampaignsResource
  readonly creatives: CreativesResource
}

export interface LinkedinClient {
  readonly adAccounts: AdAccountsResource
  readonly adAccountUsers: AdAccountUsersResource
  readonly adAnalytics: AdAnalyticsResource
  readonly organizationAcls: OrganizationAclsResource
  readonly organizations: OrganizationsResource
  readonly posts: PostsResource
  readonly socialMetadata: SocialMetadataResource
  readonly comments: CommentsResource
  readonly reactions: ReactionsResource
  readonly organizationAnalytics: OrganizationAnalyticsResource
  readonly memberAnalytics: MemberAnalyticsResource
  readonly images: ImagesResource
  readonly videos: VideosResource
  readonly documents: DocumentsResource
  adAccount(id: LinkedinId): LinkedinAdAccountClient
}
