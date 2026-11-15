import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"

/** Where a run stands. */
export type GitHubWorkflowRunStatus =
  | "requested"
  | "queued"
  | "pending"
  | "waiting"
  | "in_progress"
  | "completed"

/** How a completed run or job ended. */
export type GitHubWorkflowConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure"

/** A workflow file in `.github/workflows`. */
export interface GitHubWorkflow {
  readonly id: number
  readonly node_id: string
  readonly name: string
  /** Such as `.github/workflows/ci.yml`. */
  readonly path: string
  readonly state:
    | "active"
    | "deleted"
    | "disabled_fork"
    | "disabled_inactivity"
    | "disabled_manually"
  readonly created_at: string
  readonly updated_at: string
  readonly html_url: string
  readonly badge_url: string
}

/** One side of a pull request a run was triggered for. */
export interface GitHubWorkflowRunPullRequestRef {
  readonly ref: string
  readonly sha: string
  readonly repo: { readonly id: number; readonly url: string; readonly name: string }
}

/**
 * A pull request a run belongs to, as GitHub links it. Empty for a run from a fork, and for a push
 * GitHub did not match to an open pull request: match those by `head_branch` or `head_sha`.
 */
export interface GitHubWorkflowRunPullRequest {
  readonly id: number
  readonly number: number
  readonly url: string
  readonly head: GitHubWorkflowRunPullRequestRef
  readonly base: GitHubWorkflowRunPullRequestRef
}

/** The repository a run's commit came from: another one for a run from a fork. */
export interface GitHubWorkflowRunRepository {
  readonly id: number
  readonly name: string
  readonly full_name: string
  readonly html_url: string
}

/** One run of a workflow, at one attempt. */
export interface GitHubWorkflowRun {
  readonly id: number
  readonly node_id: string
  /** The workflow's name. */
  readonly name: string | null
  /** What the run shows, such as the pull request's or commit's title. */
  readonly display_title: string
  readonly workflow_id: number
  /** Such as `.github/workflows/ci.yml`. */
  readonly path: string
  readonly run_number: number
  readonly run_attempt: number
  /** What triggered it, such as `push`, `pull_request` or `workflow_dispatch`. */
  readonly event: string
  readonly status: GitHubWorkflowRunStatus | null
  readonly conclusion: GitHubWorkflowConclusion | null
  readonly head_branch: string | null
  readonly head_sha: string
  readonly pull_requests: readonly GitHubWorkflowRunPullRequest[]
  readonly head_repository: GitHubWorkflowRunRepository
  readonly repository: GitHubWorkflowRunRepository
  readonly check_suite_id: number
  readonly actor: GitHubUser | null
  /** Who started this attempt, such as the person who re-ran it. */
  readonly triggering_actor: GitHubUser | null
  readonly created_at: string
  readonly updated_at: string
  readonly run_started_at: string
  readonly html_url: string
  readonly jobs_url: string
  readonly logs_url: string
  readonly previous_attempt_url: string | null
}

/** One step of a job. */
export interface GitHubWorkflowJobStep {
  readonly number: number
  readonly name: string
  readonly status: "queued" | "in_progress" | "completed"
  readonly conclusion: GitHubWorkflowConclusion | null
  readonly started_at: string | null
  readonly completed_at: string | null
}

/** One job of a run, at one attempt. */
export interface GitHubWorkflowJob {
  readonly id: number
  readonly node_id: string
  readonly run_id: number
  readonly run_attempt: number
  readonly name: string
  readonly workflow_name: string | null
  readonly status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending"
  readonly conclusion: GitHubWorkflowConclusion | null
  readonly head_branch: string | null
  readonly head_sha: string
  readonly created_at: string
  readonly started_at: string
  readonly completed_at: string | null
  readonly steps?: readonly GitHubWorkflowJobStep[]
  readonly labels: readonly string[]
  readonly runner_name: string | null
  readonly runner_group_name: string | null
  readonly html_url: string | null
}

/** A file a run uploaded, such as a test report or a build. */
export interface GitHubWorkflowArtifact {
  readonly id: number
  readonly node_id: string
  readonly name: string
  readonly size_in_bytes: number
  readonly expired: boolean
  readonly created_at: string | null
  readonly expires_at: string | null
  readonly updated_at: string | null
  readonly digest?: string | null
  readonly workflow_run?: {
    readonly id: number
    readonly repository_id: number
    readonly head_branch: string
    readonly head_sha: string
  } | null
}

/** A workflow, by its id or its file name, such as `ci.yml`. */
export type GitHubWorkflowRef = number | string

export interface ListWorkflowRunsOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /** Only this workflow's runs, by id or file name. */
  readonly workflow?: GitHubWorkflowRef
  readonly branch?: string
  /** Such as `push`, `pull_request` or `workflow_dispatch`. */
  readonly event?: string
  /** A status, or a conclusion such as `failure`. */
  readonly status?: GitHubWorkflowRunStatus | GitHubWorkflowConclusion
  /** The login of whoever triggered it. */
  readonly actor?: string
  readonly headSha?: string
  /** GitHub's date syntax, such as `>=2026-11-01` or `2026-11-01..2026-11-07`. */
  readonly created?: string
  readonly checkSuiteId?: number
  /** Leave out `pull_requests`, for faster lists. */
  readonly excludePullRequests?: boolean
}

export interface WorkflowRunAttemptOptions extends GitHubRequestOptions {
  /** One attempt of a re-run run; the latest otherwise. */
  readonly attempt?: number
}

export interface ListWorkflowJobsOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /** One attempt's jobs. Without it, `filter` picks the latest attempt's or all of them. */
  readonly attempt?: number
  readonly filter?: "latest" | "all"
}

export interface ListWorkflowArtifactsOptions
  extends GitHubPaginationOptions,
    GitHubRequestOptions {
  readonly name?: string
}

export interface RerunWorkflowRunOptions extends GitHubRequestOptions {
  /** Re-run only the jobs that failed, and those that depend on them. */
  readonly failedOnly?: boolean
  readonly enableDebugLogging?: boolean
}

export interface RepositoryWorkflowsApi {
  /** List one page of this repository's workflows. */
  list(
    options?: GitHubPaginationOptions & GitHubRequestOptions
  ): Promise<GitHubPage<GitHubWorkflow>>
  get(workflow: GitHubWorkflowRef, options?: GitHubRequestOptions): Promise<GitHubWorkflow>
}

export interface RepositoryWorkflowRunsApi {
  /** List one page of runs, newest first: the repository's, or one workflow's with `workflow`. */
  list(options?: ListWorkflowRunsOptions): Promise<GitHubPage<GitHubWorkflowRun>>
  get(runId: number, options?: WorkflowRunAttemptOptions): Promise<GitHubWorkflowRun>
  /** List one page of a run's jobs, with their steps. */
  jobs(runId: number, options?: ListWorkflowJobsOptions): Promise<GitHubPage<GitHubWorkflowJob>>
  /** List one page of the files a run uploaded. */
  artifacts(
    runId: number,
    options?: ListWorkflowArtifactsOptions
  ): Promise<GitHubPage<GitHubWorkflowArtifact>>
  /** A run's logs, as one zip of every job's. */
  logs(runId: number, options?: WorkflowRunAttemptOptions): Promise<Response>
  /** Run it again: all its jobs, or only those that failed. Needs `Actions: write`. */
  rerun(runId: number, options?: RerunWorkflowRunOptions): Promise<void>
  /** Cancel it while it runs. Needs `Actions: write`. */
  cancel(runId: number, options?: GitHubRequestOptions): Promise<void>
}

export interface RepositoryWorkflowJobsApi {
  get(jobId: number, options?: GitHubRequestOptions): Promise<GitHubWorkflowJob>
  /** A job's log, as plain text. */
  logs(jobId: number, options?: GitHubRequestOptions): Promise<Response>
}

export interface RepositoryWorkflowArtifactsApi {
  /** An artifact's files, as a zip. GitHub refuses one that expired. */
  download(artifactId: number, options?: GitHubRequestOptions): Promise<Response>
}

/** GitHub Actions in one repository. Reading needs `Actions: read`. */
export interface RepositoryActionsApi {
  readonly workflows: RepositoryWorkflowsApi
  readonly runs: RepositoryWorkflowRunsApi
  readonly jobs: RepositoryWorkflowJobsApi
  readonly artifacts: RepositoryWorkflowArtifactsApi
}
