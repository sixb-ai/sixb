import type { GitHubCommit } from "./commits"
import type { GitHubRequestOptions } from "./common"
import type { GitHubDiffEntry } from "./diff"

/** How two refs stand to each other. */
export type GitHubCompareStatus = "diverged" | "ahead" | "behind" | "identical"

export interface CompareRefs {
  /** The ref the comparison starts from: a branch, a tag or a commit SHA. */
  readonly base: string
  /** The ref it ends at. */
  readonly head: string
}

export interface CompareOptions extends GitHubRequestOptions {
  /**
   * `three-dot`, the default, counts the changes since the two refs' merge base, which is the diff a
   * pull request shows; `two-dot` counts them from `base` itself.
   */
  readonly diff?: "three-dot" | "two-dot"
}

/** Two refs compared, with the commits between them and the files they change. */
export interface GitHubCompare {
  readonly url: string
  readonly html_url: string
  readonly permalink_url: string
  readonly diff_url: string
  readonly patch_url: string
  /** The commit `base` names. */
  readonly base_commit: GitHubCommit
  /** The commit both sides share, which a three-dot diff counts from. */
  readonly merge_base_commit: GitHubCommit
  readonly status: GitHubCompareStatus
  /** Commits `head` has that `base` does not. */
  readonly ahead_by: number
  /** Commits `base` has that `head` does not. */
  readonly behind_by: number
  readonly total_commits: number
  /** Oldest first. */
  readonly commits: readonly GitHubCommit[]
  /** Up to 300 files, each with its patch, as a pull request's files are described. */
  readonly files: readonly GitHubDiffEntry[]
}

export interface RepositoryCompareApi {
  /** Compare two refs. Names containing `/` work, such as `feature/login`. */
  compare(refs: CompareRefs, options?: CompareOptions): Promise<GitHubCompare>
}
