import type { MetaHttpContext } from "./http"
import { createBatchApi } from "./resources/batch"
import { createFacebookPageApi } from "./resources/facebook"
import { createInstagramMediaApi, createInstagramUserApi } from "./resources/instagram"
import { createPagesApi } from "./resources/pages"
import type { MetaClient } from "./types/client"

export function createMetaClient(context: MetaHttpContext): MetaClient {
  return {
    batch: createBatchApi(context),
    pages: createPagesApi(context),
    instagram: (igUserId) => createInstagramUserApi(context, igUserId),
    instagramMedia: (mediaId) => createInstagramMediaApi(context, mediaId),
    facebook: (pageId, options) => createFacebookPageApi(context, pageId, options),
  }
}
