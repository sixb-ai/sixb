import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"

export interface ListCommitsOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /** A branch name or commit SHA to list from. Defaults to the default branch. */
  readonly sha?: string
  /** Only commits that touch this file path. */
  readonly path?: string
  /** Only commits by this GitHub login or email address. */
  readonly author?: string
  /** Only commits committed by this GitHub login or email address. */
  readonly committer?: string
  /** Only commits at or after this ISO 8601 timestamp. */
  readonly since?: string
  /** Only commits before this ISO 8601 timestamp. */
  readonly until?: string
}

/** The name, email and time Git recorded, which need not match a GitHub account. */
export interface GitHubGitActor {
  readonly name: string
  readonly email: string
  readonly date: string
}

export interface GitHubCommitParent {
  readonly sha: string
  readonly url: string
  readonly html_url: string
}

export interface GitHubCommit {
  readonly sha: string
  readonly node_id: string
  readonly html_url: string
  readonly commit: {
    readonly message: string
    readonly author: GitHubGitActor | null
    readonly committer: GitHubGitActor | null
    readonly comment_count: number
  }
  /** The GitHub account for the author's email, or `null` when none matches. */
  readonly author: GitHubUser | null
  /** The GitHub account for the committer's email, or `null` when none matches. */
  readonly committer: GitHubUser | null
  readonly parents: readonly GitHubCommitParent[]
}

export interface GitHubCommitFile {
  readonly filename: string
  readonly status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
  readonly additions: number
  readonly deletions: number
  readonly changes: number
  /** Absent for binary files and very large diffs. */
  readonly patch?: string
  /** Set when the file was renamed. */
  readonly previous_filename?: string
}

/** A commit as `commits.get()` returns it, with its size and changed files. */
export interface GitHubCommitDetail extends GitHubCommit {
  readonly stats: {
    readonly additions: number
    readonly deletions: number
    readonly total: number
  }
  readonly files: readonly GitHubCommitFile[]
}

export interface RepositoryCommitsApi {
  /** List one page of this repository's commits, newest first. */
  list(options?: ListCommitsOptions): Promise<GitHubPage<GitHubCommit>>
  /** Get a commit by SHA, branch or tag. Names may contain `/`, such as `release/1.0`. */
  get(ref: string, options?: GitHubRequestOptions): Promise<GitHubCommitDetail>
}
