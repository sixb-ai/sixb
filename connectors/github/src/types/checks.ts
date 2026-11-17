import type { GitHubWorkflowConclusion, GitHubWorkflowRunStatus } from "./actions"
import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"
import type { GitHubRepository } from "./repos"

/** Where a check run stands, the vocabulary a workflow run uses. */
export type GitHubCheckRunStatus = GitHubWorkflowRunStatus

/** How a completed check run ended, the vocabulary a workflow run uses. */
export type GitHubCheckRunConclusion = GitHubWorkflowConclusion

/** The statuses GitHub filters check runs by. */
export type GitHubCheckRunStatusFilter = "queued" | "in_progress" | "completed"

export interface ListCheckRunsOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /** Only runs with this check name. */
  readonly checkName?: string
  readonly status?: GitHubCheckRunStatusFilter
  /**
   * `latest`, the default, keeps the newest run of each check name; `all` keeps every one, which
   * is how a re-run's earlier attempts show up.
   */
  readonly filter?: "latest" | "all"
}

/** What a check run reported, as the Markdown an Annotations view shows. */
export interface GitHubCheckRunOutput {
  readonly title: string | null
  readonly summary: string | null
  readonly text: string | null
  readonly annotations_count: number
  readonly annotations_url: string
}

export interface GitHubCheckRunSuiteRef {
  readonly id: number
}

/** The GitHub App that ran the check. */
export interface GitHubCheckRunApp {
  readonly id: number
  readonly node_id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly external_url: string
  readonly html_url: string
}

/** A pull request a check run's commit belongs to. */
export interface GitHubCheckRunPullRequest {
  readonly id: number
  readonly number: number
  readonly url: string
}

/**
 * One check run: what an App or a CI system reported about a commit. A workflow's jobs reach the
 * API as check runs too, which is how a pull request's rollup is read.
 */
export interface GitHubCheckRun {
  readonly id: number
  readonly node_id: string
  /** The check's name, such as `ci / test`. */
  readonly name: string
  readonly head_sha: string
  readonly external_id: string | null
  readonly url: string
  readonly html_url: string | null
  readonly details_url: string | null
  readonly status: GitHubCheckRunStatus
  /** `null` until the run completes. */
  readonly conclusion: GitHubCheckRunConclusion | null
  readonly started_at: string | null
  readonly completed_at: string | null
  readonly output: GitHubCheckRunOutput
  readonly check_suite: GitHubCheckRunSuiteRef | null
  /** `null` for a check GitHub ran itself rather than through an App. */
  readonly app: GitHubCheckRunApp | null
  readonly pull_requests: readonly GitHubCheckRunPullRequest[]
}

/** The state a commit status reports. */
export type GitHubCommitStatusState = "error" | "failure" | "pending" | "success"

/** One entry of the Commit Status API, which posts a context and a state onto a commit. */
export interface GitHubCommitStatus {
  readonly id: number
  readonly node_id: string
  readonly state: GitHubCommitStatusState
  readonly description: string | null
  /** Where the state came from, such as `ci/build`; a commit carries one per context. */
  readonly context: string
  readonly target_url: string | null
  /** Whether a branch protection rule asks for this context. */
  readonly required: boolean
  readonly avatar_url: string | null
  readonly url: string
  readonly created_at: string
  readonly updated_at: string
  readonly creator: GitHubUser | null
}

/**
 * Every status on one commit, rolled up: `failure` when any context reports an error or a failure,
 * `pending` when one is pending or none was ever reported, `success` when all are.
 */
export interface GitHubCombinedStatus {
  readonly state: Exclude<GitHubCommitStatusState, "error">
  readonly sha: string
  readonly total_count: number
  readonly statuses: readonly GitHubCommitStatus[]
  readonly repository: GitHubRepository
  readonly commit_url: string
  readonly url: string
}

export interface RepositoryChecksApi {
  /** List one page of a commit's, branch's or tag's check runs. */
  list(ref: string, options?: ListCheckRunsOptions): Promise<GitHubPage<GitHubCheckRun>>
  /**
   * Read GitHub's combined status for a commit, branch or tag: the rollup of the older Commit
   * Status API, separate from check runs.
   */
  status(ref: string, options?: GitHubRequestOptions): Promise<GitHubCombinedStatus>
}
