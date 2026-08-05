import type { GoogleHttp } from "../../http"
import type { Profile, WatchRequest, WatchResponse } from "../../types/gmail"
import { gmailUserPath } from "./paths"

export interface GmailUsersResource {
  getProfile(userId: string): Promise<Profile>
  watch(userId: string, request: WatchRequest): Promise<WatchResponse>
  stop(userId: string): Promise<void>
}

export function gmailUsersResource(http: GoogleHttp): GmailUsersResource {
  return {
    getProfile(userId) {
      return http.json<Profile>("gmail", "GET", gmailUserPath(userId, "/profile"))
    },
    watch(userId, request) {
      return http.json<WatchResponse>("gmail", "POST", gmailUserPath(userId, "/watch"), {
        body: request,
      })
    },
    stop(userId) {
      return http.json<void>("gmail", "POST", gmailUserPath(userId, "/stop"))
    },
  }
}
