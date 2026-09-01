import type { TiktokDisplayClient } from "../types/client"
import type { TiktokConnectedAccount } from "../types/common"
import type { TiktokDisplayHttp } from "./http"
import { createDisplayProfileApi, createDisplayVideosApi } from "./resources"

export function createDisplayClient(
  http: TiktokDisplayHttp,
  account: TiktokConnectedAccount<"tiktok-account">
): TiktokDisplayClient {
  return {
    account,
    profile: createDisplayProfileApi(http),
    videos: createDisplayVideosApi(http),
  }
}
