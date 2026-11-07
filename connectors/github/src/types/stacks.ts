import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"

/**
 * Where a pull request sits in its stack, as `pulls.list()` and `pulls.get()` return it on
 * `stack`. Positions count from 1 at the bottom of the stack, the pull request into `base`.
 */
export interface GitHubPullRequestStackPosition {
  readonly id: number
  /** The stack's number, from the same sequence as the repository's issues and pull requests. */
  readonly number: number
  /** How many pull requests the stack holds. */
  readonly size: number
  /** This pull request's place in the stack, from 1 at the bottom to `size` at the top. */
  readonly position: number
  /** The branch the whole stack merges into, not the pull request's own parent branch. */
  readonly base: { readonly ref: string; readonly sha: string }
}

/** A pull request in a stack, as `stacks.list()` summarizes it. */
export interface GitHubStackPullRequestSummary {
  readonly number: number
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly merged_at: string | null
  readonly head: { readonly ref: string; readonly sha: string }
}

/** One side of a pull request in a stack. */
export interface GitHubStackPullRequestBranch {
  readonly ref: string
  readonly sha: string
  /** A short form of the repository: `id`, `name` and API `url`. */
  readonly repo: { readonly id: number; readonly name: string; readonly url: string } | null
}

/** A pull request in a stack, as `stacks.get()` returns it. */
export interface GitHubStackPullRequest {
  readonly id: number
  readonly node_id: string
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly merged_at: string | null
  readonly user: GitHubUser
  /** The branch of the pull request below it, or the stack's base for the first one. */
  readonly base: GitHubStackPullRequestBranch
  readonly head: GitHubStackPullRequestBranch
  readonly url: string
  readonly html_url: string
}

interface GitHubStackFields {
  readonly id: number
  readonly node_id: string
  readonly number: number
  readonly url: string
  /** The branch the stack merges into. */
  readonly base: { readonly ref: string }
  /** `false` once every pull request in it is merged or closed. */
  readonly open: boolean
  readonly created_at: string
}

/** A stack as `stacks.list()` returns it. Its pull requests run from the bottom up. */
export interface GitHubStackSummary extends GitHubStackFields {
  readonly pull_requests: readonly GitHubStackPullRequestSummary[]
}

/** A stack as `stacks.get()` returns it. Its pull requests run from the bottom up. */
export interface GitHubStack extends GitHubStackFields {
  readonly pull_requests: readonly GitHubStackPullRequest[]
}

export interface ListStacksOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /** Only the stack holding this pull request. */
  readonly pullRequest?: number
}

export interface RepositoryStacksApi {
  /** List one page of this repository's stacks of pull requests. */
  list(options?: ListStacksOptions): Promise<GitHubPage<GitHubStackSummary>>
  get(stackNumber: number, options?: GitHubRequestOptions): Promise<GitHubStack>
}
