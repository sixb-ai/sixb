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
import type {
  GitHubBranch,
  GitHubBranchDetail,
  ListBranchesOptions,
  RepositoryBranchesApi,
} from "../types/branches"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"

export function createRepositoryBranchesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryBranchesApi {
  const path = `${repositoryPath(target)}/branches`

  return {
    async list(options?: ListBranchesOptions): Promise<GitHubPage<GitHubBranch>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.protected !== undefined) params.set("protected", String(options.protected))
      return readPage<GitHubBranch>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(branch: string, options?: GitHubRequestOptions): Promise<GitHubBranchDetail> {
      return readJson<GitHubBranchDetail>(
        await context.http.get(`${path}/${pathPart(branch, "branch")}`, {
          signal: options?.signal,
        })
      )
    },
  }
}
