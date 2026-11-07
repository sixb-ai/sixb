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
  GitHubCommit,
  GitHubCommitDetail,
  ListCommitsOptions,
  RepositoryCommitsApi,
} from "../types/commits"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"

const FILTERS = ["sha", "path", "author", "committer", "since", "until"] as const

export function createRepositoryCommitsApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryCommitsApi {
  const path = `${repositoryPath(target)}/commits`

  return {
    async list(options?: ListCommitsOptions): Promise<GitHubPage<GitHubCommit>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      for (const filter of FILTERS) {
        const value = options?.[filter]
        if (value) params.set(filter, value)
      }
      return readPage<GitHubCommit>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(ref: string, options?: GitHubRequestOptions): Promise<GitHubCommitDetail> {
      return readJson<GitHubCommitDetail>(
        await context.http.get(`${path}/${pathPart(ref, "ref")}`, { signal: options?.signal })
      )
    },
  }
}
