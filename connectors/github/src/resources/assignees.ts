import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathPart,
  readPage,
  readPresence,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { ListAssigneesOptions, RepositoryAssigneesApi } from "../types/assignees"
import type {
  GitHubPage,
  GitHubRepositoryTarget,
  GitHubRequestOptions,
  GitHubUser,
} from "../types/common"

export function createRepositoryAssigneesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryAssigneesApi {
  const path = `${repositoryPath(target)}/assignees`

  return {
    async list(options?: ListAssigneesOptions): Promise<GitHubPage<GitHubUser>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      return readPage<GitHubUser>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async check(username: string, options?: GitHubRequestOptions): Promise<boolean> {
      return readPresence(
        await context.http.get(`${path}/${pathPart(username, "username")}`, {
          signal: options?.signal,
        })
      )
    },
  }
}
