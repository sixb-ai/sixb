import type { MetaBatchApi } from "./batch"
import type { FacebookPageApi } from "./facebook"
import type { InstagramMediaApi, InstagramUserApi } from "./instagram"
import type { PagesApi } from "./pages"
import type { FacebookVideoApi, InstagramContainerApi, MetaResourceOptions } from "./publishing"

export interface MetaClient {
  /** Read-only Graph API batch requests. */
  readonly batch: MetaBatchApi

  /** `GET /me/accounts` — Facebook Pages and their linked Instagram accounts. */
  readonly pages: PagesApi

  /** Scope for an Instagram Business/Creator user node. */
  instagram(igUserId: string, options?: MetaResourceOptions): InstagramUserApi

  /** Scope for a single IG media node and its own insights edge. */
  instagramMedia(mediaId: string, options?: MetaResourceOptions): InstagramMediaApi

  instagramContainer(containerId: string, options?: MetaResourceOptions): InstagramContainerApi

  facebookVideo(videoId: string, options?: MetaResourceOptions): FacebookVideoApi

  /**
   * Scope for a Facebook Page node. Pass the Page access token (from
   * `MetaFacebookPage.access_token`) to authorize Page-level operations; without it the
   * connector falls back to the default user/system token.
   */
  facebook(pageId: string, options?: MetaResourceOptions): FacebookPageApi
}
