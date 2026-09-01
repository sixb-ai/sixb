import type { TiktokCursorPage, TiktokExtensible } from "./common"

export type TiktokDisplayScope = TiktokExtensible<
  "user.info.basic" | "user.info.profile" | "user.info.stats" | "video.list"
>

export type TiktokDisplayUserField =
  | "open_id"
  | "union_id"
  | "avatar_url"
  | "avatar_url_100"
  | "avatar_large_url"
  | "display_name"
  | "bio_description"
  | "profile_deep_link"
  | "is_verified"
  | "username"
  | "follower_count"
  | "following_count"
  | "likes_count"
  | "video_count"

export interface TiktokDisplayUser {
  readonly open_id?: string
  readonly union_id?: string
  readonly avatar_url?: string
  readonly avatar_url_100?: string
  readonly avatar_large_url?: string
  readonly display_name?: string
  readonly bio_description?: string
  readonly profile_deep_link?: string
  readonly is_verified?: boolean
  readonly username?: string
  readonly follower_count?: number
  readonly following_count?: number
  readonly likes_count?: number
  readonly video_count?: number
  readonly [field: string]: unknown
}

export interface TiktokDisplayProfileQuery {
  /** Defaults to fields covered by `user.info.basic`. */
  readonly fields?: readonly TiktokDisplayUserField[]
}

export type TiktokDisplayVideoField =
  | "id"
  | "create_time"
  | "cover_image_url"
  | "share_url"
  | "video_description"
  | "duration"
  | "height"
  | "width"
  | "title"
  | "embed_html"
  | "embed_link"
  | "like_count"
  | "comment_count"
  | "share_count"
  | "view_count"

export interface TiktokDisplayVideo {
  readonly id: string
  /** UTC Unix timestamp in seconds. */
  readonly create_time?: number
  readonly cover_image_url?: string
  readonly share_url?: string
  readonly video_description?: string
  readonly duration?: number
  readonly height?: number
  readonly width?: number
  readonly title?: string
  readonly embed_html?: string
  readonly embed_link?: string
  readonly like_count?: number
  readonly comment_count?: number
  readonly share_count?: number
  readonly view_count?: number
  readonly [field: string]: unknown
}

export interface TiktokDisplayVideosListQuery {
  /** Defaults to all currently documented video fields. */
  readonly fields?: readonly TiktokDisplayVideoField[]
  /** Cursor from `nextCursor`, expressed as Unix time in milliseconds. */
  readonly cursor?: number
  /** 1-20. Defaults to TikTok's page size. */
  readonly maxCount?: number
}

export interface TiktokDisplayVideosQuery {
  /** One to 20 video IDs owned by the authorized user. */
  readonly videoIds: readonly string[]
  /** Defaults to all currently documented video fields. */
  readonly fields?: readonly TiktokDisplayVideoField[]
}

export interface TiktokDisplayProfileApi {
  get(query?: TiktokDisplayProfileQuery): Promise<TiktokDisplayUser>
}

export interface TiktokDisplayVideosApi {
  list(query?: TiktokDisplayVideosListQuery): Promise<TiktokCursorPage<TiktokDisplayVideo>>
  listAll(query?: TiktokDisplayVideosListQuery): AsyncIterable<TiktokDisplayVideo>
  query(query: TiktokDisplayVideosQuery): Promise<readonly TiktokDisplayVideo[]>
}
