import type { InsightsQuery, MetaInsight, MetaPage, MetaPaginationOptions } from "./common"

/** An attachment on a Facebook Page post. All attachments are returned, not just the first. */
export interface MetaFacebookAttachment {
  readonly title?: string
  readonly description?: string
  readonly url?: string
  readonly type?: string
  readonly media?: {
    readonly image?: {
      readonly src?: string
      readonly width?: number
      readonly height?: number
    }
  }
  readonly target?: {
    readonly id?: string
    readonly url?: string
  }
}

/** A published Facebook Page post. */
export interface MetaFacebookPost {
  readonly id: string
  readonly message?: string
  readonly story?: string
  /** Raw Graph API timestamp — passed through unchanged. */
  readonly created_time?: string
  readonly permalink_url?: string
  readonly status_type?: string
  readonly attachments?: readonly MetaFacebookAttachment[]
  /** From `reactions.summary.total_count`. */
  readonly reactions_count?: number
  /** From `comments.summary.total_count`. */
  readonly comments_count?: number
  /** From `shares.count`. */
  readonly shares_count?: number
  /** Present when `metrics` were requested inline via `insights.metric(...)` expansion. */
  readonly insights?: readonly MetaInsight[]
}

export interface PostsListOptions extends MetaPaginationOptions {
  /** Field selection. Defaults to `DEFAULT_FACEBOOK_POST_FIELDS`. */
  readonly fields?: readonly string[]
  /** When set, requests these insight metrics inline via `insights.metric(...).period(lifetime)`. */
  readonly metrics?: readonly string[]
  /** Only posts created at or after this time, serialized to Unix seconds. */
  readonly since?: Date
  /** Only posts created before this time, serialized to Unix seconds. */
  readonly until?: Date
}

/** The Facebook Page profile node (`GET /{page-id}`), including audience size. */
export interface MetaFacebookPageProfile {
  readonly id: string
  readonly name?: string
  /** Total Page likes. */
  readonly fan_count?: number
  /** Total Page followers. */
  readonly followers_count?: number
}

/** Scope for a Facebook Page node. */
export interface FacebookPageApi {
  /** `GET /{page-id}` — the Page profile node. */
  get(options?: { readonly fields?: readonly string[] }): Promise<MetaFacebookPageProfile>
  readonly posts: {
    /** One page of `GET /{page-id}/published_posts`. */
    list(options?: PostsListOptions): Promise<MetaPage<MetaFacebookPost>>
    /** Every post, following `paging.next` across all pages. */
    listAll(options?: PostsListOptions): AsyncIterable<MetaFacebookPost>
  }
  readonly insights: {
    /** `GET /{page-id}/insights`. */
    get(options: InsightsQuery): Promise<readonly MetaInsight[]>
  }
}
