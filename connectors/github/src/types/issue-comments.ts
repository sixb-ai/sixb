import type { GitHubBodyFormatOptions } from "./attachments"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"
import type { GitHubSortDirection } from "./repos"

export interface ListIssueCommentsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions,
    GitHubBodyFormatOptions {
  /** Only show comments updated at or after this ISO 8601 timestamp. */
  readonly since?: string
}

export interface ListRepositoryIssueCommentsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions,
    GitHubBodyFormatOptions {
  /** Only comments updated at or after this ISO 8601 timestamp. */
  readonly since?: string
  /** Defaults to `created`. */
  readonly sort?: "created" | "updated"
  /** Applies only with `sort`. */
  readonly direction?: GitHubSortDirection
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
  /** Absent with `bodyFormat` `text` or `html`, which return only `body_text` or `body_html`. */
  readonly body: string
  /** With `bodyFormat` `text` or `full`. */
  readonly body_text?: string | null
  /** With `bodyFormat` `html` or `full`. */
  readonly body_html?: string | null
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
  /**
   * List one page of comments on every issue and pull request in the repository. Each names its
   * issue in `issue_url`, whose last path segment is the issue number.
   */
  listForRepository(
    options?: ListRepositoryIssueCommentsOptions
  ): Promise<GitHubPage<GitHubIssueComment>>
  create(issueNumber: number, input: CreateIssueCommentInput): Promise<GitHubIssueComment>
  get(
    commentId: number,
    options?: GitHubRequestOptions & GitHubBodyFormatOptions
  ): Promise<GitHubIssueComment>
  update(commentId: number, input: UpdateIssueCommentInput): Promise<GitHubIssueComment>
  delete(commentId: number): Promise<void>
}
