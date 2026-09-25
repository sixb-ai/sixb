import type { MetaHttpContext } from "./http"
import { createBatchApi } from "./resources/batch"
import { createFacebookPageApi } from "./resources/facebook"
import { createFacebookVideoApi } from "./resources/facebook-publishing"
import { createInstagramMediaApi, createInstagramUserApi } from "./resources/instagram"
import { createInstagramContainerApi } from "./resources/instagram-publishing"
import { createPagesApi } from "./resources/pages"
import type { MetaClient } from "./types/client"

export function createMetaClient(context: MetaHttpContext): MetaClient {
  return {
    batch: createBatchApi(context),
    pages: createPagesApi(context),
    instagram: (igUserId, options) => createInstagramUserApi(context, igUserId, options),
    instagramMedia: (mediaId, options) => createInstagramMediaApi(context, mediaId, options),
    instagramContainer: (id, options) => createInstagramContainerApi(context, id, options),
    facebookVideo: (id, options) => createFacebookVideoApi(context, id, options),
    facebook: (pageId, options) => createFacebookPageApi(context, pageId, options),
  }
}
