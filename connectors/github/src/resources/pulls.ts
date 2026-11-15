import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  assertNonEmpty,
  bodyFormatHeaders,
  GitHubApiError,
  pathId,
  readJson,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"
import type {
  CreatePullRequestInput,
  GetPullRequestOptions,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubPullRequestMergeRefusal,
  GitHubPullRequestMergeResult,
  GitHubPullRequestReview,
  ListPullRequestReviewsOptions,
  ListPullRequestsOptions,
  MergePullRequestInput,
  RepositoryPullRequestsApi,
  RequestReviewersInput,
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

    async create(
      input: CreatePullRequestInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubPullRequest> {
      assertNonEmpty(input.title, "title")
      assertNonEmpty(input.head, "head")
      assertNonEmpty(input.base, "base")
      return readJson<GitHubPullRequest>(
        await context.http.post(path, pullRequestBody(input), { signal: options?.signal })
      )
    },

    async requestReviewers(
      pullNumber: number,
      input: RequestReviewersInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubPullRequest> {
      if (!input.reviewers?.length && !input.teamReviewers?.length) {
        throw new Error("[SixbGitHub] requestReviewers needs reviewers or teamReviewers.")
      }
      for (const reviewer of input.reviewers ?? []) assertNonEmpty(reviewer, "reviewers")
      for (const team of input.teamReviewers ?? []) assertNonEmpty(team, "teamReviewers")
      return readJson<GitHubPullRequest>(
        await context.http.post(
          `${pullPath(pullNumber)}/requested_reviewers`,
          { reviewers: input.reviewers, team_reviewers: input.teamReviewers },
          { signal: options?.signal }
        )
      )
    },

    async merge(
      pullNumber: number,
      input?: MergePullRequestInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubPullRequestMergeResult> {
      return readMerge(
        await context.http.request(`${pullPath(pullNumber)}/merge`, {
          method: "PUT",
          body: {
            commit_title: input?.commitTitle,
            commit_message: input?.commitMessage,
            sha: input?.sha,
            merge_method: input?.method,
          },
          signal: options?.signal,
        })
      )
    },
  }
}

function pullRequestBody(input: CreatePullRequestInput): Record<string, unknown> {
  return {
    title: input.title,
    head: input.head,
    base: input.base,
    body: input.body,
    draft: input.draft,
    maintainer_can_modify: input.maintainerCanModify,
    issue: input.issue,
  }
}

/** GitHub's answer to a merge attempt, one per status it documents. */
const MERGE_REFUSALS: Readonly<Record<number, GitHubPullRequestMergeRefusal>> = {
  403: "forbidden",
  404: "not_found",
  405: "not_mergeable",
  409: "head_changed",
  422: "invalid",
}

/**
 * Read the merge endpoint's answer. Its refusals are answers, not failures: 405 means the pull
 * request cannot be merged right now, 409 that the head branch moved, and a caller telling them
 * apart is the whole point, so they come back as a result. Any other status is an error.
 */
async function readMerge(response: Response): Promise<GitHubPullRequestMergeResult> {
  const text = await response.text().catch(() => "")
  const body = parseMergeBody(text)
  const message = body.message ?? text

  if (response.ok && body.merged && body.sha) {
    return { merged: true, sha: body.sha, message }
  }

  const reason = MERGE_REFUSALS[response.status]
  if (reason) return { merged: false, reason, message }

  // A 200 without `merged` narrows to the one refusal a caller can act on, by re-reading the pull
  // request. Anything else is a status GitHub does not document for a merge.
  if (response.ok) return { merged: false, reason: "not_mergeable", message }
  throw new GitHubApiError(response.status, text)
}

function parseMergeBody(text: string): { merged?: boolean; sha?: string; message?: string } {
  try {
    const body = JSON.parse(text) as unknown
    return typeof body === "object" && body !== null ? (body as Record<string, never>) : {}
  } catch {
    return {}
  }
}
