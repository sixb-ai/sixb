import type { GitHubBodyFormatOptions } from "./attachments"
import type { GitHubPage, GitHubPaginationOptions, GitHubRequestOptions } from "./common"
import type { GitHubIssue } from "./issues"

export interface ListRelatedIssuesOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions,
    GitHubBodyFormatOptions {}

export interface RepositorySubIssuesApi {
  /** List one page of an issue's sub-issues, in the order set on GitHub. */
  list(issueNumber: number, options?: ListRelatedIssuesOptions): Promise<GitHubPage<GitHubIssue>>
}

export interface RepositoryIssueDependenciesApi {
  /** List one page of the issues blocking this one. */
  blockedBy(
    issueNumber: number,
    options?: ListRelatedIssuesOptions
  ): Promise<GitHubPage<GitHubIssue>>
  /** List one page of the issues this one blocks. */
  blocking(
    issueNumber: number,
    options?: ListRelatedIssuesOptions
  ): Promise<GitHubPage<GitHubIssue>>
}
