import type { GitHubPage, GitHubPaginationOptions, GitHubRequestOptions } from "./common"

export interface ListBranchesOptions extends GitHubPaginationOptions, GitHubRequestOptions {
  /**
   * `true` lists only branches protected by branch protection or rulesets, `false` only the
   * others. Omit it to list every branch.
   */
  readonly protected?: boolean
}

export interface GitHubBranchCommit {
  readonly sha: string
  /** API URL of the commit. */
  readonly url: string
}

export interface GitHubBranch {
  readonly name: string
  /** The commit at the tip of the branch. */
  readonly commit: GitHubBranchCommit
  readonly protected: boolean
  readonly protection_url?: string
}

/** A branch as `branches.get()` returns it. Its `commit` also carries GitHub's full commit. */
export interface GitHubBranchDetail extends GitHubBranch {
  readonly _links: {
    /** Web page of the branch. */
    readonly html: string
    readonly self: string
  }
}

export interface RepositoryBranchesApi {
  /** List one page of this repository's branches. */
  list(options?: ListBranchesOptions): Promise<GitHubPage<GitHubBranch>>
  /** Get a branch by name. Names may contain `/`, such as `feature/login`. */
  get(branch: string, options?: GitHubRequestOptions): Promise<GitHubBranchDetail>
}
