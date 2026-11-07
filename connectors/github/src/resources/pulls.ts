import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  bodyFormatHeaders,
  pathId,
  readJson,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget } from "../types/common"
import type {
  GetPullRequestOptions,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubPullRequestReview,
  ListPullRequestReviewsOptions,
  ListPullRequestsOptions,
  RepositoryPullRequestsApi,
} from "../types/pulls"

export function createRepositoryPullRequestsApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryPullRequestsApi {
  const path = `${repositoryPath(target)}/pulls`
  const pullPath = (pullNumber: number) => `${path}/${pathId(pullNumber, "pullNumber")}`

  return {
    reviews: {
      async list(
        pullNumber: number,
        options?: ListPullRequestReviewsOptions
      ): Promise<GitHubPage<GitHubPullRequestReview>> {
        const params = new URLSearchParams()
        applyPaging(params, options)
        const reviewsPath = withQuery(`${pullPath(pullNumber)}/reviews`, params)
        return readPage<GitHubPullRequestReview>(
          await context.http.get(resolvePagePath(reviewsPath, options), {
            signal: options?.signal,
          }),
          context.apiBaseUrl
        )
      },
    },

    async list(options?: ListPullRequestsOptions): Promise<GitHubPage<GitHubPullRequest>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.state) params.set("state", options.state)
      if (options?.head) params.set("head", options.head)
      if (options?.base) params.set("base", options.base)
      if (options?.sort) params.set("sort", options.sort)
      if (options?.direction) params.set("direction", options.direction)
      return readPage<GitHubPullRequest>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          headers: bodyFormatHeaders(options?.bodyFormat),
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(
      pullNumber: number,
      options?: GetPullRequestOptions
    ): Promise<GitHubPullRequestDetail> {
      return readJson<GitHubPullRequestDetail>(
        await context.http.get(pullPath(pullNumber), {
          headers: bodyFormatHeaders(options?.bodyFormat),
          signal: options?.signal,
        })
      )
    },
  }
}
