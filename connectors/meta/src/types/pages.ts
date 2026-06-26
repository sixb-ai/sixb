import type { MetaPage, MetaPaginationOptions } from "./common"

/** An Instagram Business/Creator account linked to a Facebook Page. */
export interface MetaInstagramAccount {
  readonly id: string
  readonly username?: string
  readonly name?: string
  readonly followers_count?: number
  readonly media_count?: number
}

/** A Facebook Page returned by `GET /me/accounts`. */
export interface MetaFacebookPage {
  readonly id: string
  readonly name?: string
  /** Page access token — use it to scope `client.facebook(id, { accessToken })` reads. */
  readonly access_token?: string
  readonly instagram_business_account?: MetaInstagramAccount
}

export interface PagesListOptions extends MetaPaginationOptions {
  /** Field selection. Defaults to `DEFAULT_PAGE_FIELDS`. */
  readonly fields?: readonly string[]
}

export interface PagesApi {
  /** One page of `GET /me/accounts`. */
  list(options?: PagesListOptions): Promise<MetaPage<MetaFacebookPage>>
  /** Every Page, following `paging.next` across all pages. */
  listAll(options?: PagesListOptions): AsyncIterable<MetaFacebookPage>
}
