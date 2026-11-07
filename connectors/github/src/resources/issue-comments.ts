import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  bodyFormatHeaders,
  pathId,
  readJson,
  readNoContent,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubBodyFormatOptions } from "../types/attachments"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"
import type {
  CreateIssueCommentInput,
  GitHubIssueComment,
  ListIssueCommentsOptions,
  ListRepositoryIssueCommentsOptions,
  RepositoryIssueCommentsApi,
  UpdateIssueCommentInput,
} from "../types/issue-comments"

export function createRepositoryIssueCommentsApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryIssueCommentsApi {
  const commentsPath = `${repositoryPath(target)}/issues/comments`
  const issuePath = `${repositoryPath(target)}/issues`

  return {
    async list(
      issueNumber: number,
      options?: ListIssueCommentsOptions
    ): Promise<GitHubPage<GitHubIssueComment>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.since) params.set("since", options.since)
      const path = withQuery(`${issuePath}/${pathId(issueNumber, "issueNumber")}/comments`, params)
      return readPage<GitHubIssueComment>(
        await context.http.get(resolvePagePath(path, options), {
          headers: bodyFormatHeaders(options?.bodyFormat),
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async listForRepository(
      options?: ListRepositoryIssueCommentsOptions
    ): Promise<GitHubPage<GitHubIssueComment>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      if (options?.since) params.set("since", options.since)
      if (options?.sort) params.set("sort", options.sort)
      if (options?.direction) params.set("direction", options.direction)
      return readPage<GitHubIssueComment>(
        await context.http.get(resolvePagePath(withQuery(commentsPath, params), options), {
          headers: bodyFormatHeaders(options?.bodyFormat),
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async create(issueNumber: number, input: CreateIssueCommentInput): Promise<GitHubIssueComment> {
      const path = `${issuePath}/${pathId(issueNumber, "issueNumber")}/comments`
      return readJson<GitHubIssueComment>(await context.http.post(path, { body: input.body }))
    },

    async get(
      commentId: number,
      options?: GitHubRequestOptions & GitHubBodyFormatOptions
    ): Promise<GitHubIssueComment> {
      return readJson<GitHubIssueComment>(
        await context.http.get(commentPath(commentsPath, commentId), {
          headers: bodyFormatHeaders(options?.bodyFormat),
          signal: options?.signal,
        })
      )
    },

    async update(commentId: number, input: UpdateIssueCommentInput): Promise<GitHubIssueComment> {
      return readJson<GitHubIssueComment>(
        await context.http.request(commentPath(commentsPath, commentId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: input.body }),
        })
      )
    },

    async delete(commentId: number): Promise<void> {
      return readNoContent(
        await context.http.request(commentPath(commentsPath, commentId), { method: "DELETE" })
      )
    },
  }
}

function commentPath(commentsPath: string, commentId: number): string {
  return `${commentsPath}/${pathId(commentId, "commentId")}`
}
