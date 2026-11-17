import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathPart,
  readJson,
  readWrappedPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type {
  GitHubCheckRun,
  GitHubCombinedStatus,
  ListCheckRunsOptions,
  RepositoryChecksApi,
} from "../types/checks"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"

export function createRepositoryChecksApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryChecksApi {
  const commitPath = (ref: string) => `${repositoryPath(target)}/commits/${pathPart(ref, "ref")}`

  return {
    async list(ref: string, options?: ListCheckRunsOptions): Promise<GitHubPage<GitHubCheckRun>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.checkName) params.set("check_name", options.checkName)
      if (options?.status) params.set("status", options.status)
      if (options?.filter) params.set("filter", options.filter)
      return readWrappedPage<GitHubCheckRun>(
        await context.http.get(
          resolvePagePath(withQuery(`${commitPath(ref)}/check-runs`, params), options),
          {
            signal: options?.signal,
          }
        ),
        context.apiBaseUrl,
        "check_runs"
      )
    },

    async status(ref: string, options?: GitHubRequestOptions): Promise<GitHubCombinedStatus> {
      return readJson<GitHubCombinedStatus>(
        await context.http.get(`${commitPath(ref)}/status`, { signal: options?.signal })
      )
    },
  }
}
