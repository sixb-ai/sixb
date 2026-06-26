import type { FacebookPageApi } from "./facebook"
import type { InstagramMediaApi, InstagramUserApi } from "./instagram"
import type { PagesApi } from "./pages"

export interface MetaClient {
  /** `GET /me/accounts` — Facebook Pages and their linked Instagram accounts. */
  readonly pages: PagesApi

  /** Scope for an Instagram Business/Creator user node. */
  instagram(igUserId: string): InstagramUserApi

  /** Scope for a single IG media node and its own insights edge. */
  instagramMedia(mediaId: string): InstagramMediaApi

  /**
   * Scope for a Facebook Page node. Pass the Page access token (from
   * `MetaFacebookPage.access_token`) to authorize Page-level reads; without it the
   * connector falls back to the default user/system token.
   */
  facebook(pageId: string, options?: { readonly accessToken?: string }): FacebookPageApi
}
