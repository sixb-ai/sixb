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

export interface CreatePullRequestInput {
  readonly title: string
  /** The branch the changes come from, as `branch`, or `owner:branch` for a fork. */
  readonly head: string
  /** The branch they go into. */
  readonly base: string
  readonly body?: string
  /** Opens it as a draft, which cannot be merged until it is marked ready. */
  readonly draft?: boolean
  /** Lets maintainers of the base repository push to the head branch. */
  readonly maintainerCanModify?: boolean
  /** The issue to turn into a pull request, in a repository that enables it. */
  readonly issue?: number
}

export interface RequestReviewersInput {
  /** Usernames to ask. */
  readonly reviewers?: readonly string[]
  /** Team slugs to ask, such as `platform`. */
  readonly teamReviewers?: readonly string[]
}

/** How GitHub may combine the commits it merges. */
export type GitHubPullRequestMergeMethod = "merge" | "squash" | "rebase"

export interface MergePullRequestInput {
  readonly method?: GitHubPullRequestMergeMethod
  /** The merge commit's title; GitHub writes its own when this is empty. */
  readonly commitTitle?: string
  /** The merge commit's body, appended to the title. */
  readonly commitMessage?: string
  /** Merge only while the head branch is still at this commit. */
  readonly sha?: string
}

/** Why GitHub refused a merge, one value per answer it documents. */
export type GitHubPullRequestMergeRefusal =
  /** 405: a required review or check is missing, or the branches conflict. */
  | "not_mergeable"
  /** 409: the head branch moved since the caller read it. */
  | "head_changed"
  /** 403: a branch protection rule or ruleset, or a token without write access. */
  | "forbidden"
  /** 404: no such pull request, or the token cannot see it. */
  | "not_found"
  /** 422: GitHub refused the input, such as a merge method the repository forbids. */
  | "invalid"

/**
 * How a merge ended. A refusal is one of GitHub's own answers, so it comes back as a result rather
 * than as a thrown error: a caller deciding whether to merge reads the reason, and only an answer
 * GitHub does not document throws.
 */
export type GitHubPullRequestMergeResult =
  | {
      readonly merged: true
      /** The merge commit. */
      readonly sha: string
      /** GitHub's confirmation, such as `Pull Request successfully merged`. */
      readonly message: string
    }
  | {
      readonly merged: false
      readonly reason: GitHubPullRequestMergeRefusal
      /** GitHub's explanation, which is all it gives a refusal. */
      readonly message: string
    }

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
  /** Open a pull request between two branches, or from an issue. */
  create(input: CreatePullRequestInput, options?: GitHubRequestOptions): Promise<GitHubPullRequest>
  /**
   * Ask users or teams to review. GitHub replaces the request when a pull request is edited with
   * `requested_reviewers`, so ask again after that rather than assuming it stands.
   */
  requestReviewers(
    pullNumber: number,
    input: RequestReviewersInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequest>
  /**
   * Merge a pull request, with `merge`, `squash` or `rebase`. The repository's own settings decide
   * which methods it allows, and branch protection decides whether this one may be merged.
   */
  merge(
    pullNumber: number,
    input?: MergePullRequestInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequestMergeResult>
}
