import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathPart,
  readJson,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"
import type { GitHubRelease, ListReleasesOptions, RepositoryReleasesApi } from "../types/releases"

export function createRepositoryReleasesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryReleasesApi {
  const path = `${repositoryPath(target)}/releases`

  return {
    async list(options?: ListReleasesOptions): Promise<GitHubPage<GitHubRelease>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      return readPage<GitHubRelease>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async getByTag(tag: string, options?: GitHubRequestOptions): Promise<GitHubRelease> {
      return readJson<GitHubRelease>(
        await context.http.get(`${path}/tags/${pathPart(tag, "tag")}`, {
          signal: options?.signal,
        })
      )
    },
  }
}
