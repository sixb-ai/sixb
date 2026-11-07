import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"

export interface ListAssigneesOptions extends GitHubPaginationOptions, GitHubRequestOptions {}

export interface RepositoryAssigneesApi {
  /** List one page of the users who can be assigned to this repository's issues and pull requests. */
  list(options?: ListAssigneesOptions): Promise<GitHubPage<GitHubUser>>
  /** Whether a user can be assigned. */
  check(username: string, options?: GitHubRequestOptions): Promise<boolean>
}
