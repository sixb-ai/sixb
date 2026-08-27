import type { TiktokHttp } from "../http"
import type { TiktokOrganicClient } from "../types/client"
import type { TiktokConnectedAccount } from "../types/common"
import {
  createOrganicCommentsApi,
  createOrganicPostsApi,
  createOrganicProfileApi,
} from "./resources"

export function createOrganicClient(
  http: TiktokHttp,
  account: TiktokConnectedAccount<"tiktok-account">
): TiktokOrganicClient {
  return {
    account,
    profile: createOrganicProfileApi(http, account.id),
    posts: createOrganicPostsApi(http, account.id),
    comments: createOrganicCommentsApi(http, account.id),
  }
}
