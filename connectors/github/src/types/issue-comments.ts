import type { GitHubPage, GitHubPaginationOptions, GitHubUser } from "./common"

export interface ListIssueCommentsOptions extends GitHubPaginationOptions {
  /** Only show comments updated at or after this ISO 8601 timestamp. */
  readonly since?: string
}

export interface CreateIssueCommentInput {
  readonly body: string
}

export interface UpdateIssueCommentInput {
  readonly body: string
}

export interface GitHubIssueComment {
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly html_url: string
  readonly body: string
  readonly user: GitHubUser
  readonly created_at: string
  readonly updated_at: string
  readonly issue_url: string
  readonly author_association: string
}

export interface RepositoryIssueCommentsApi {
  /** List one page of comments for an issue or pull request. */
  list(
    issueNumber: number,
    options?: ListIssueCommentsOptions
  ): Promise<GitHubPage<GitHubIssueComment>>
  create(issueNumber: number, input: CreateIssueCommentInput): Promise<GitHubIssueComment>
  get(commentId: number): Promise<GitHubIssueComment>
  update(commentId: number, input: UpdateIssueCommentInput): Promise<GitHubIssueComment>
  delete(commentId: number): Promise<void>
}
