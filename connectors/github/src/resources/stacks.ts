import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  pathId,
  readJson,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"
import type {
  GitHubStack,
  GitHubStackSummary,
  ListStacksOptions,
  RepositoryStacksApi,
} from "../types/stacks"

export function createRepositoryStacksApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryStacksApi {
  const path = `${repositoryPath(target)}/stacks`

  return {
    async list(options?: ListStacksOptions): Promise<GitHubPage<GitHubStackSummary>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.pullRequest !== undefined) {
        params.set("pull_request", pathId(options.pullRequest, "pullRequest"))
      }
      return readPage<GitHubStackSummary>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(stackNumber: number, options?: GitHubRequestOptions): Promise<GitHubStack> {
      return readJson<GitHubStack>(
        await context.http.get(`${path}/${pathId(stackNumber, "stackNumber")}`, {
          signal: options?.signal,
        })
      )
    },
  }
}
