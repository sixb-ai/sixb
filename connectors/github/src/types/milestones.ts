import type { GitHubPage, GitHubPaginationOptions, GitHubRequestOptions } from "./common"
import type { GitHubMilestone } from "./issues"
import type { GitHubSortDirection } from "./repos"

export interface ListMilestonesOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /** Defaults to `open`. */
  readonly state?: "open" | "closed" | "all"
  /** Defaults to `due_on`. */
  readonly sort?: "due_on" | "completeness"
  readonly direction?: GitHubSortDirection
}

export interface RepositoryMilestonesApi {
  /** List one page of this repository's milestones. */
  list(options?: ListMilestonesOptions): Promise<GitHubPage<GitHubMilestone>>
  get(milestoneNumber: number, options?: GitHubRequestOptions): Promise<GitHubMilestone>
}
