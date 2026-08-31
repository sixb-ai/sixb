import type { TiktokCursorPage, TiktokExtensible, TiktokSortOrder } from "./common"

export type TiktokOrganicProfileField =
  | "is_business_account"
  | "profile_image"
  | "username"
  | "profile_deep_link"
  | "display_name"
  | "bio_description"
  | "is_verified"
  | "following_count"
  | "followers_count"
  | "total_likes"
  | "videos_count"
  | "video_views"
  | "unique_video_views"
  | "profile_views"
  | "likes"
  | "comments"
  | "shares"
  | "phone_number_clicks"
  | "lead_submissions"
  | "app_download_clicks"
  | "bio_link_clicks"
  | "email_clicks"
  | "address_clicks"
  | "daily_total_followers"
  | "daily_new_followers"
  | "daily_lost_followers"
  | "audience_activity"
  | "engaged_audience"
  | "audience_ages"
  | "audience_genders"
  | "audience_countries"
  | "audience_cities"

export interface TiktokAudienceActivity {
  readonly hour: string
  readonly count: number
}

export interface TiktokAudienceAge {
  readonly age: TiktokExtensible<"18-24" | "25-34" | "35-44" | "45-54" | "55+">
  readonly percentage: number
}

export interface TiktokAudienceGender {
  readonly gender: TiktokExtensible<"Female" | "Male" | "Other">
  readonly percentage: number
}

export interface TiktokAudienceCountry {
  readonly country: string
  readonly percentage: number
}

export interface TiktokAudienceCity {
  readonly city_name: string
  readonly percentage: number
}

export interface TiktokOrganicProfileMetric {
  readonly date: string
  readonly video_views?: number
  readonly unique_video_views?: number
  readonly profile_views?: number
  readonly likes?: number
  readonly comments?: number
  readonly shares?: number
  readonly phone_number_clicks?: number
  readonly lead_submissions?: number
  readonly app_download_clicks?: number
  readonly bio_link_clicks?: number
  readonly email_clicks?: number
  readonly address_clicks?: number
  readonly daily_total_followers?: number
  readonly daily_new_followers?: number
  readonly daily_lost_followers?: number
  readonly audience_activity?: readonly TiktokAudienceActivity[]
  readonly engaged_audience?: number
  readonly audience_ages?: readonly TiktokAudienceAge[]
  readonly audience_genders?: readonly TiktokAudienceGender[]
  readonly audience_countries?: readonly TiktokAudienceCountry[]
  readonly audience_cities?: readonly TiktokAudienceCity[]
  readonly [field: string]: unknown
}

export interface TiktokOrganicProfile {
  readonly business_id?: string
  readonly is_business_account?: boolean
  readonly profile_image?: string
  readonly username?: string
  readonly profile_deep_link?: string
  readonly display_name?: string
  readonly bio_description?: string
  readonly is_verified?: boolean
  readonly following_count?: number
  readonly followers_count?: number
  readonly total_likes?: number
  readonly videos_count?: number
  readonly metrics?: readonly TiktokOrganicProfileMetric[]
  readonly [field: string]: unknown
}

export interface TiktokOrganicProfileQuery {
  /** UTC date in `YYYY-MM-DD` format. TikTok accepts at most a 60-day window. */
  readonly startDate?: string
  /** UTC date in `YYYY-MM-DD` format. */
  readonly endDate?: string
  /** Omit to use TikTok's default `display_name` and `profile_image` fields. */
  readonly fields?: readonly TiktokOrganicProfileField[]
}

export type TiktokOrganicPostField =
  | "item_id"
  | "media_type"
  | "is_ad"
  | "thumbnail_url"
  | "share_url"
  | "embed_url"
  | "caption"
  | "video_duration"
  | "likes"
  | "comments"
  | "shares"
  | "favorites"
  | "create_time"
  | "reach"
  | "video_views"
  | "total_time_watched"
  | "average_time_watched"
  | "full_video_watched_rate"
  | "new_followers"
  | "profile_views"
  | "website_clicks"
  | "phone_number_clicks"
  | "lead_submissions"
  | "app_download_clicks"
  | "email_clicks"
  | "address_clicks"
  | "video_view_retention"
  | "impression_sources"
  | "audience_genders"
  | "audience_countries"
  | "audience_cities"
  | "audience_types"
  | "engagement_likes"

export interface TiktokPercentageAtSecond {
  readonly second: number
  readonly percentage: number
}

export interface TiktokPercentageBySource {
  readonly impression_source: string
  readonly percentage: number
}

export interface TiktokAudienceType {
  readonly type: TiktokExtensible<
    "NEW_VIEWER" | "RETURN_VIEWER" | "FOLLOWER_PERCENT" | "NON_FOLLOWER_PERCENT"
  >
  readonly percentage: number
}

export interface TiktokOrganicPost {
  readonly item_id: string
  readonly media_type?: TiktokExtensible<"VIDEO" | "PHOTO">
  readonly is_ad?: boolean
  readonly thumbnail_url?: string
  readonly share_url?: string
  readonly embed_url?: string
  readonly caption?: string
  readonly video_duration?: number
  readonly likes?: number
  readonly comments?: number
  readonly shares?: number
  readonly favorites?: number
  /** Unix timestamp returned as a string by TikTok. */
  readonly create_time?: string
  readonly reach?: number
  readonly video_views?: number
  readonly total_time_watched?: number
  readonly average_time_watched?: number
  readonly full_video_watched_rate?: number
  readonly new_followers?: number
  readonly profile_views?: number
  readonly website_clicks?: number
  readonly phone_number_clicks?: number
  readonly lead_submissions?: number
  readonly app_download_clicks?: number
  readonly email_clicks?: number
  readonly address_clicks?: number
  readonly video_view_retention?: readonly TiktokPercentageAtSecond[]
  readonly impression_sources?: readonly TiktokPercentageBySource[]
  readonly audience_genders?: readonly TiktokAudienceGender[]
  readonly audience_countries?: readonly TiktokAudienceCountry[]
  readonly audience_cities?: readonly TiktokAudienceCity[]
  readonly audience_types?: readonly TiktokAudienceType[]
  readonly engagement_likes?: readonly TiktokPercentageAtSecond[]
  readonly [field: string]: unknown
}

export interface TiktokOrganicPostsListQuery {
  /** Omit to request only TikTok's default `item_id` field. */
  readonly fields?: readonly TiktokOrganicPostField[]
  readonly videoIds?: readonly string[]
  readonly adPostOnly?: boolean
  /** Cursor from `nextCursor`, expressed as Unix time in milliseconds. */
  readonly cursor?: number
  /** 1-20. Defaults to TikTok's page size. */
  readonly maxCount?: number
}

export type TiktokCommentStatus = "PUBLIC" | "ALL"
export type TiktokCommentSortField = "likes" | "replies" | "create_time"

export interface TiktokOrganicComment {
  readonly comment_id: string
  readonly video_id: string
  readonly user_id?: string
  readonly unique_identifier?: string
  readonly create_time?: number
  readonly text?: string
  readonly likes?: number
  readonly replies?: number
  readonly owner?: boolean
  readonly liked?: boolean
  readonly pinned?: boolean
  readonly status?: TiktokExtensible<"HIDDEN" | "PUBLIC">
  readonly username?: string
  readonly display_name?: string
  readonly profile_image?: string
  readonly parent_comment_id?: string
  readonly reply_list?: readonly TiktokOrganicComment[]
  readonly image_url?: string
  readonly [field: string]: unknown
}

interface TiktokCommentsListQueryBase {
  readonly videoId: string
  readonly status?: TiktokCommentStatus
  readonly sortField?: TiktokCommentSortField
  readonly sortOrder?: TiktokSortOrder
  readonly cursor?: number
  /** 1-30. Defaults to TikTok's page size. */
  readonly maxCount?: number
}

export interface TiktokOrganicCommentsListQuery extends TiktokCommentsListQueryBase {
  readonly commentIds?: readonly string[]
  readonly includeReplies?: boolean
}

export interface TiktokOrganicRepliesListQuery extends TiktokCommentsListQueryBase {
  readonly commentId: string
}

export interface TiktokOrganicProfileApi {
  get(query?: TiktokOrganicProfileQuery): Promise<TiktokOrganicProfile>
}

export interface TiktokOrganicPostsApi {
  list(query?: TiktokOrganicPostsListQuery): Promise<TiktokCursorPage<TiktokOrganicPost>>
  listAll(query?: TiktokOrganicPostsListQuery): AsyncIterable<TiktokOrganicPost>
}

export interface TiktokOrganicRepliesApi {
  list(query: TiktokOrganicRepliesListQuery): Promise<TiktokCursorPage<TiktokOrganicComment>>
  listAll(query: TiktokOrganicRepliesListQuery): AsyncIterable<TiktokOrganicComment>
}

export interface TiktokOrganicCommentsApi {
  readonly replies: TiktokOrganicRepliesApi
  list(query: TiktokOrganicCommentsListQuery): Promise<TiktokCursorPage<TiktokOrganicComment>>
  listAll(query: TiktokOrganicCommentsListQuery): AsyncIterable<TiktokOrganicComment>
}
