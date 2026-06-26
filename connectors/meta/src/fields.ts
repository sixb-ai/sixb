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
