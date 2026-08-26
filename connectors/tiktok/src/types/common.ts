export type TiktokAccountType = "organic-account" | "ad-account"

export interface TiktokConnectedAccount<TType extends TiktokAccountType> {
  readonly type: TType
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly avatarUrl?: string
}

export interface TiktokResponseMetadata {
  readonly path: string
  readonly method: "GET" | "POST"
  readonly status: number
  readonly requestId?: string
  readonly logId?: string
  /** Raw `X-Tt-Ads-Throttle` value returned by the Ads API. */
  readonly adsThrottle?: string
}

export interface TiktokRetryOptions {
  /** Number of retries for network errors, HTTP 429, and HTTP 5xx responses. Defaults to 2. */
  readonly maxRetries?: number
}

export interface TiktokCursorPage<T> {
  readonly items: readonly T[]
  readonly hasMore: boolean
  readonly nextCursor?: number
  readonly requestId?: string
}

export interface TiktokPageInfo {
  readonly page: number
  readonly page_size: number
  readonly total_number: number
  readonly total_page?: number
}

export interface TiktokNumberedPage<T> {
  readonly items: readonly T[]
  readonly pageInfo: TiktokPageInfo
  readonly requestId?: string
}

export type TiktokSortOrder = "asc" | "desc"

export type TiktokExtensible<T extends string> = T | (string & {})
