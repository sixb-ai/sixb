import type { RestClient } from "@sixb/connector-rest"
import type { MetaHttpContext } from "./http"
import { createFacebookPageApi } from "./resources/facebook"
import { createInstagramMediaApi, createInstagramUserApi } from "./resources/instagram"
import { createPagesApi } from "./resources/pages"
import type { MetaClient } from "./types/client"

export function createMetaClient(http: RestClient): MetaClient {
  const context: MetaHttpContext = { http }
  return {
    pages: createPagesApi(context),
    instagram: (igUserId) => createInstagramUserApi(context, igUserId),
    instagramMedia: (mediaId) => createInstagramMediaApi(context, mediaId),
    facebook: (pageId, options) => createFacebookPageApi(context, pageId, options),
  }
}
