import type { GitHubBodyFormatOptions } from "./attachments"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"
import type { GitHubLabel, GitHubMilestone } from "./issues"
import type { GitHubRepository, GitHubSortDirection } from "./repos"
import type { GitHubPullRequestStackPosition } from "./stacks"

export type GitHubPullRequestState = "open" | "closed" | "all"
export type GitHubPullRequestSort = "created" | "updated" | "popularity" | "long-running"

export interface ListPullRequestsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions,
    GitHubBodyFormatOptions {
  /** Defaults to `open`. */
  readonly state?: GitHubPullRequestState
  /** Only pull requests from this branch, as `user:ref-name` or `organization:ref-name`. */
  readonly head?: string
  /** Only pull requests into this branch. */
  readonly base?: string
  readonly sort?: GitHubPullRequestSort
  readonly direction?: GitHubSortDirection
}

export interface GetPullRequestOptions extends GitHubRequestOptions, GitHubBodyFormatOptions {}

/** One side of a pull request: the branch it comes from (`head`) or goes into (`base`). */
export interface GitHubPullRequestBranch {
  /** `owner:ref`. */
  readonly label: string
  readonly ref: string
  readonly sha: string
  readonly user: GitHubUser | null
  /** `null` when the fork it came from was deleted. */
  readonly repo: GitHubRepository | null
}

export interface GitHubPullRequest {
  readonly id: number
  readonly node_id: string
  readonly number: number
  readonly title: string
  readonly body: string | null
  /** With `bodyFormat` `text` or `full`. */
  readonly body_text?: string | null
  /** With `bodyFormat` `html` or `full`. */
  readonly body_html?: string | null
  /** A merged pull request is `closed` with `merged_at` set. */
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly locked: boolean
  readonly user: GitHubUser
  readonly labels: readonly GitHubLabel[]
  readonly assignees: readonly GitHubUser[]
  readonly requested_reviewers: readonly GitHubUser[]
  readonly milestone: GitHubMilestone | null
  readonly head: GitHubPullRequestBranch
  readonly base: GitHubPullRequestBranch
  readonly author_association: string
  readonly merged_at: string | null
  readonly closed_at: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly html_url: string
  readonly diff_url: string
  readonly patch_url: string
  /**
   * Where the pull request sits in a stack of dependent pull requests. GitHub leaves it out for
   * a pull request outside any stack.
   */
  readonly stack?: GitHubPullRequestStackPosition | null
}

/** A pull request as `pulls.get()` returns it, with its merge state and size. */
export interface GitHubPullRequestDetail extends GitHubPullRequest {
  readonly merged: boolean
  /** `null` while GitHub is still computing it. */
  readonly mergeable: boolean | null
  readonly merged_by: GitHubUser | null
  /** Conversation comments. */
  readonly comments: number
  /** Comments on the diff. */
  readonly review_comments: number
  readonly commits: number
  readonly additions: number
  readonly deletions: number
  readonly changed_files: number
}

export type GitHubPullRequestReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING"

export interface GitHubPullRequestReview {
  readonly id: number
  readonly node_id: string
  /** `null` when the reviewer's account was deleted. */
  readonly user: GitHubUser | null
  readonly body: string
  readonly state: GitHubPullRequestReviewState
  /** The commit the review was left on. */
  readonly commit_id: string | null
  readonly html_url: string
  /** Absent while the review is pending. */
  readonly submitted_at?: string
  readonly author_association: string
}

export interface ListPullRequestReviewsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions {}

export interface RepositoryPullRequestReviewsApi {
  /** List one page of a pull request's reviews, oldest first. */
  list(
    pullNumber: number,
    options?: ListPullRequestReviewsOptions
  ): Promise<GitHubPage<GitHubPullRequestReview>>
}

export interface RepositoryPullRequestsApi {
  readonly reviews: RepositoryPullRequestReviewsApi
  /** List one page of this repository's pull requests. */
  list(options?: ListPullRequestsOptions): Promise<GitHubPage<GitHubPullRequest>>
  get(pullNumber: number, options?: GetPullRequestOptions): Promise<GitHubPullRequestDetail>
}
