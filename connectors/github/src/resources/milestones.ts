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
import type { GitHubMilestone } from "../types/issues"
import type { ListMilestonesOptions, RepositoryMilestonesApi } from "../types/milestones"

export function createRepositoryMilestonesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryMilestonesApi {
  const path = `${repositoryPath(target)}/milestones`

  return {
    async list(options?: ListMilestonesOptions): Promise<GitHubPage<GitHubMilestone>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.state) params.set("state", options.state)
      if (options?.sort) params.set("sort", options.sort)
      if (options?.direction) params.set("direction", options.direction)
      return readPage<GitHubMilestone>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(milestoneNumber: number, options?: GitHubRequestOptions): Promise<GitHubMilestone> {
      return readJson<GitHubMilestone>(
        await context.http.get(`${path}/${pathId(milestoneNumber, "milestoneNumber")}`, {
          signal: options?.signal,
        })
      )
    },
  }
}
