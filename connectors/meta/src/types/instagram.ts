import type { InsightsQuery, MetaInsight, MetaPage, MetaPaginationOptions } from "./common"

/** The IG User profile node (`GET /{ig-user-id}`). */
export interface MetaInstagramUser {
  readonly id: string
  readonly username?: string
  readonly name?: string
  readonly biography?: string
  readonly website?: string
  readonly profile_picture_url?: string
  readonly followers_count?: number
  readonly follows_count?: number
  readonly media_count?: number
}

/** A child item of a carousel (`CAROUSEL_ALBUM`) media. */
export interface MetaInstagramMediaChild {
  readonly id: string
  readonly media_type?: string
  readonly media_url?: string
  readonly permalink?: string
  readonly timestamp?: string
  readonly thumbnail_url?: string
}

/** An IG media object (feed post, reel, or story). */
export interface MetaInstagramMedia {
  readonly id: string
  readonly caption?: string
  readonly media_type?: string
  readonly media_product_type?: string
  readonly media_url?: string
  readonly thumbnail_url?: string
  readonly permalink?: string
  /** Raw Graph API timestamp — passed through unchanged. */
  readonly timestamp?: string
  readonly username?: string
  readonly like_count?: number
  readonly comments_count?: number
  readonly children?: readonly MetaInstagramMediaChild[]
  /** Present when `metrics` were requested inline via `insights.metric(...)` expansion. */
  readonly insights?: readonly MetaInsight[]
}

export interface MediaListOptions extends MetaPaginationOptions {
  /** Field selection. Defaults to `DEFAULT_INSTAGRAM_MEDIA_FIELDS`. */
  readonly fields?: readonly string[]
  /** When set, requests these insight metrics inline via `insights.metric(...)` expansion. */
  readonly metrics?: readonly string[]
}

export interface StoriesListOptions extends MetaPaginationOptions {
  /** Field selection. Defaults to `DEFAULT_INSTAGRAM_STORY_FIELDS`. */
  readonly fields?: readonly string[]
  /** When set, requests these insight metrics inline via `insights.metric(...)` expansion. */
  readonly metrics?: readonly string[]
}

/** Scope for an Instagram Business/Creator user node. */
export interface InstagramUserApi {
  /** `GET /{ig-user-id}` — the IG User profile node. */
  get(options?: { readonly fields?: readonly string[] }): Promise<MetaInstagramUser>
  readonly media: {
    /** One page of `GET /{ig-user-id}/media`. */
    list(options?: MediaListOptions): Promise<MetaPage<MetaInstagramMedia>>
    /** Every media item, following `paging.next` across all pages. */
    listAll(options?: MediaListOptions): AsyncIterable<MetaInstagramMedia>
  }
  readonly stories: {
    /** One page of `GET /{ig-user-id}/stories`. */
    list(options?: StoriesListOptions): Promise<MetaPage<MetaInstagramMedia>>
    /** Every active story, following `paging.next` across all pages. */
    listAll(options?: StoriesListOptions): AsyncIterable<MetaInstagramMedia>
  }
  readonly insights: {
    /** `GET /{ig-user-id}/insights`. */
    get(options: InsightsQuery): Promise<readonly MetaInsight[]>
  }
}

/** Scope for a single IG media node and its insights edge. */
export interface InstagramMediaApi {
  readonly insights: {
    /** `GET /{ig-media-id}/insights`. */
    get(options: { readonly metrics: readonly string[] }): Promise<readonly MetaInsight[]>
  }
}
