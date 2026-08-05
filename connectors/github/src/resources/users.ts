import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathId,
  pathPart,
  readJson,
  readPage,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubUser } from "../types/common"
import type { GitHubUserProfile, GitHubUsersApi, ListUsersOptions } from "../types/users"

export function createGitHubUsersApi(context: GitHubHttpContext): GitHubUsersApi {
  return {
    async getAuthenticated(): Promise<GitHubUserProfile> {
      return readJson<GitHubUserProfile>(await context.http.get("/user"))
    },

    async get(username: string): Promise<GitHubUserProfile> {
      return readJson<GitHubUserProfile>(
        await context.http.get(`/users/${pathPart(username, "username")}`)
      )
    },

    async getById(accountId: number): Promise<GitHubUserProfile> {
      return readJson<GitHubUserProfile>(
        await context.http.get(`/user/${pathId(accountId, "accountId")}`)
      )
    },

    async list(options?: ListUsersOptions) {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.since !== undefined) params.set("since", String(assertSince(options.since)))
      const path = withQuery("/users", params)
      return readPage<GitHubUser>(
        await context.http.get(resolvePagePath(path, options)),
        context.apiBaseUrl
      )
    },
  }
}

function assertSince(since: number): number {
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new Error("[SixbGitHub] since must be a non-negative safe integer.")
  }
  return since
}
