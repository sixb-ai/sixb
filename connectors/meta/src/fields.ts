/**
 * Default field selections for each Graph API edge.
 *
 * Every list method accepts a `fields` option to override these. They are exported so
 * callers can extend or trim the selection without restating the full list.
 */

/** Fields for `GET /me/accounts`, including the linked IG account and the Page access token. */
export const DEFAULT_PAGE_FIELDS = [
  "id",
  "name",
  "access_token",
  "instagram_business_account{id,username,name,followers_count,media_count}",
] as const

/** Fields for `GET /{ig-user-id}` — the IG User profile node. */
export const DEFAULT_INSTAGRAM_USER_FIELDS = [
  "id",
  "username",
  "name",
  "biography",
  "website",
  "profile_picture_url",
  "followers_count",
  "follows_count",
  "media_count",
] as const

/** Fields for `GET /{page-id}` — the Facebook Page profile node (audience size). */
export const DEFAULT_FACEBOOK_PAGE_FIELDS = ["id", "name", "fan_count", "followers_count"] as const

/** Fields for `GET /{ig-user-id}/media`. `children{...}` expands carousel items. */
export const DEFAULT_INSTAGRAM_MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
  "username",
  "like_count",
  "comments_count",
  "children{id,media_type,media_url,permalink,timestamp,thumbnail_url}",
] as const

/** Fields for `GET /{ig-user-id}/stories`. Stories have no carousel children. */
export const DEFAULT_INSTAGRAM_STORY_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
  "username",
  "like_count",
  "comments_count",
] as const

/**
 * Fields for `GET /{page-id}/published_posts`.
 *
 * `comments.summary(true).limit(0)` and `reactions.summary(total_count).limit(0)` are Graph
 * field-expansion shorthand for "give me the aggregate count, not the rows" — `limit(0)`
 * suppresses the nested data while `summary(...)` includes the `total_count`. `shares`
 * carries `{ count }`. `attachments{...}` returns every attachment on the post.
 */
export const DEFAULT_FACEBOOK_POST_FIELDS = [
  "id",
  "message",
  "story",
  "created_time",
  "permalink_url",
  "status_type",
  "comments.summary(true).limit(0)",
  "reactions.summary(total_count).limit(0)",
  "shares",
  "attachments{title,description,url,type,media,target}",
] as const

/** Fields for ad account nodes and the ad account edges. */
export const DEFAULT_AD_ACCOUNT_FIELDS = [
  "id",
  "account_id",
  "name",
  "account_status",
  "disable_reason",
  "currency",
  "timezone_name",
  "timezone_offset_hours_utc",
  "created_time",
  "amount_spent",
  "business{id,name}",
] as const

/** Fields for `GET /{business-id}/pending_client_ad_accounts`. */
export const DEFAULT_PENDING_AD_ACCOUNT_FIELDS = [
  "id",
  "ad_account{id,account_id,name,currency,timezone_name}",
  "owner_business{id,name}",
] as const

/** Fields for `GET /act_{id}/campaigns`. */
export const DEFAULT_AD_CAMPAIGN_FIELDS = [
  "id",
  "name",
  "objective",
  "status",
  "effective_status",
  "buying_type",
  "daily_budget",
  "lifetime_budget",
  "start_time",
  "stop_time",
  "created_time",
  "updated_time",
] as const

/** Fields for `GET /act_{id}/adsets`. */
export const DEFAULT_AD_SET_FIELDS = [
  "id",
  "campaign_id",
  "name",
  "status",
  "effective_status",
  "optimization_goal",
  "billing_event",
  "daily_budget",
  "lifetime_budget",
  "start_time",
  "end_time",
  "created_time",
  "updated_time",
] as const

/** Fields for `GET /act_{id}/ads`, with the creative's preview and copy. */
export const DEFAULT_AD_FIELDS = [
  "id",
  "campaign_id",
  "adset_id",
  "name",
  "status",
  "effective_status",
  "created_time",
  "updated_time",
  "creative{id,name,title,body,object_type,call_to_action_type,thumbnail_url,image_url,video_id,effective_object_story_id,instagram_permalink_url}",
] as const

/** Fields for `GET /act_{id}/adcreatives`. */
export const DEFAULT_AD_CREATIVE_FIELDS = [
  "id",
  "name",
  "title",
  "body",
  "object_type",
  "call_to_action_type",
  "thumbnail_url",
  "image_url",
  "video_id",
  "effective_object_story_id",
  "instagram_permalink_url",
] as const

/**
 * Fields for `GET /act_{id}/insights`. `results` and `cost_per_result` follow Ads Manager's
 * Results column: what they count depends on each campaign's objective.
 */
export const DEFAULT_ADS_INSIGHTS_FIELDS = [
  "account_id",
  "account_currency",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "objective",
  "optimization_goal",
  "attribution_setting",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",
  "actions",
  "action_values",
  "results",
  "cost_per_result",
] as const
