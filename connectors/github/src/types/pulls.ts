import type { GitHubBodyFormatOptions } from "./attachments"
import type { GitHubCommit } from "./commits"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"
import type { GitHubDiffEntry } from "./diff"
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

/** A team asked to review a pull request. */
export interface GitHubPullRequestRequestedTeam {
  readonly id: number
  readonly node_id: string
  readonly name: string
  /** What a review request takes, and what `teamReviewers` names. */
  readonly slug: string
  readonly description: string | null
  readonly privacy: string
  readonly notification_setting?: string
  readonly html_url: string
}

/**
 * GitHub's own verdict on merging a pull request: `clean` when it can be, `dirty` with a conflict,
 * `blocked` by a rule, `behind` its base, `unstable` with a failing check, `draft` while it is one,
 * and `unknown` while GitHub computes it.
 */
export type GitHubPullRequestMergeableState =
  | "clean"
  | "dirty"
  | "blocked"
  | "behind"
  | "unstable"
  | "draft"
  | "unknown"

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
  /** Teams asked to review, by name and slug. */
  readonly requested_teams: readonly GitHubPullRequestRequestedTeam[]
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
  readonly mergeable_state: GitHubPullRequestMergeableState
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

/** How a review is submitted. */
export type GitHubPullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"

/** Which side of the diff a review comment sits on: the file as changed, or as it was. */
export type GitHubPullRequestCommentSide = "LEFT" | "RIGHT"

/** One inline comment to post with a review. */
export interface CreatePullRequestReviewCommentInput {
  /** The file the comment is on, from the repository root. */
  readonly path: string
  readonly body: string
  /** The line in the file, on `side`. */
  readonly line?: number
  /** Which side of the diff `line` counts on; `RIGHT`, the file as changed, when empty. */
  readonly side?: GitHubPullRequestCommentSide
  /** The first line of a comment spanning a range that ends at `line`. */
  readonly startLine?: number
  readonly startSide?: GitHubPullRequestCommentSide
  /** A line counted in the diff; an alternative to `line`. */
  readonly position?: number
}

export interface CreatePullRequestReviewInput {
  /**
   * `APPROVE`, `REQUEST_CHANGES` or `COMMENT`. Leaving it out keeps the review pending, so comments
   * can be added before it is submitted with `reviews.submit()`.
   */
  readonly event?: GitHubPullRequestReviewEvent
  /** The review's summary. GitHub requires it for `REQUEST_CHANGES` and `COMMENT`. */
  readonly body?: string
  /** The commit to review; GitHub uses the pull request's latest when empty. */
  readonly commitId?: string
  /** Inline comments to post with the review. */
  readonly comments?: readonly CreatePullRequestReviewCommentInput[]
}

export interface SubmitPullRequestReviewInput {
  readonly event: GitHubPullRequestReviewEvent
  /** The summary posted with the verdict, replacing the pending review's own. */
  readonly body?: string
}

/** One inline comment on a pull request's diff. */
export interface GitHubPullRequestComment {
  readonly id: number
  readonly node_id: string
  readonly body: string
  /** The file the comment is on, from the repository root. */
  readonly path: string
  /** The line in the file; `null` for a comment on the whole file. */
  readonly line: number | null
  /** The first line of a comment spanning a range, or `null` for a single line. */
  readonly start_line?: number | null
  readonly original_start_line?: number | null
  readonly original_line: number | null
  readonly side: GitHubPullRequestCommentSide | null
  readonly start_side?: GitHubPullRequestCommentSide | null
  /** The line counted in the diff as the comment was left, which is how it keeps its place after a push. */
  readonly position?: number
  readonly original_position?: number
  /** The last lines of the hunk the comment sits on, as the diff shows them. */
  readonly diff_hunk: string
  readonly commit_id: string
  readonly original_commit_id: string
  /** The comment this one answers; empty for the first in a thread. */
  readonly in_reply_to_id?: number
  /** The review it was posted with; `null` for a comment on its own. */
  readonly pull_request_review_id: number | null
  readonly subject_type?: "line" | "file"
  /** `null` when the account was deleted. */
  readonly user: GitHubUser | null
  readonly created_at: string
  readonly updated_at: string
  readonly html_url: string
  readonly pull_request_url: string
}

export interface ListPullRequestFilesOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions {}

export interface ListPullRequestCommitsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions {}

export interface ListPullRequestCommentsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions,
    GitHubBodyFormatOptions {
  readonly sort?: "created" | "updated"
  readonly direction?: GitHubSortDirection
  /** Only comments updated after this time, so a sync reads just what changed. */
  readonly since?: string
}

export interface CreatePullRequestCommentInput {
  readonly body: string
  /** The file the comment is on, from the repository root. */
  readonly path: string
  /** The commit to comment on; GitHub uses the pull request's latest when empty. */
  readonly commitId?: string
  readonly line?: number
  readonly side?: GitHubPullRequestCommentSide
  readonly startLine?: number
  readonly startSide?: GitHubPullRequestCommentSide
  /** A line counted in the diff; an alternative to `line`. */
  readonly position?: number
}

export interface ReplyToPullRequestCommentInput {
  readonly body: string
}

export interface UpdatePullRequestCommentInput {
  readonly body: string
}

export interface RepositoryPullRequestCommentsApi {
  /** List one page of a pull request's inline comments, oldest first. */
  list(
    pullNumber: number,
    options?: ListPullRequestCommentsOptions
  ): Promise<GitHubPage<GitHubPullRequestComment>>
  /** Comment on a line of the diff, outside a review. One of `line` and `position` is required. */
  create(
    pullNumber: number,
    input: CreatePullRequestCommentInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequestComment>
  /** Answer a comment in its thread. */
  reply(
    commentId: number,
    input: ReplyToPullRequestCommentInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequestComment>
  /** Edit a comment's body. Only its author, or someone with write access, may. */
  update(
    commentId: number,
    input: UpdatePullRequestCommentInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequestComment>
  delete(commentId: number, options?: GitHubRequestOptions): Promise<void>
}

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
  /**
   * Submit a review, with its inline comments if it has any. Approving and requesting changes need
   * write access to the repository: a fine-grained token needs `Pull requests: read & write`.
   */
  create(
    pullNumber: number,
    input: CreatePullRequestReviewInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequestReview>
  /** Submit a review left pending by `create()` without an event. */
  submit(
    pullNumber: number,
    reviewId: number,
    input: SubmitPullRequestReviewInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubPullRequestReview>
}

export interface RepositoryPullRequestsApi {
  readonly reviews: RepositoryPullRequestReviewsApi
  /** The inline comments on its diff, where a review's comments land too. */
  readonly comments: RepositoryPullRequestCommentsApi
  /** List one page of this repository's pull requests. */
  list(options?: ListPullRequestsOptions): Promise<GitHubPage<GitHubPullRequest>>
  /**
   * List one page of the files it changes, each with the patch GitHub renders, which is the diff a
   * review reads. GitHub answers 3000 files at most, 30 a page unless `pageSize` says otherwise.
   */
  files(
    pullNumber: number,
    options?: ListPullRequestFilesOptions
  ): Promise<GitHubPage<GitHubDiffEntry>>
  /** List one page of the commits on the branch it comes from, oldest first. */
  commits(
    pullNumber: number,
    options?: ListPullRequestCommitsOptions
  ): Promise<GitHubPage<GitHubCommit>>
  get(pullNumber: number, options?: GetPullRequestOptions): Promise<GitHubPullRequestDetail>
  /** Open a pull request between two branches, or from an issue. */
  create(input: CreatePullRequestInput, options?: GitHubRequestOptions): Promise<GitHubPullRequest>
  /** Ask users or teams to review. GitHub keeps one pending request per reviewer. */
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
