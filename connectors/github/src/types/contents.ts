import type { GitHubRequestOptions } from "./common"

export interface GetContentsOptions extends GitHubRequestOptions {
  /** The branch, tag or commit to read. GitHub reads the default branch when empty. */
  readonly ref?: string
}

/** A file the contents API returns, its bytes base64 encoded. */
export interface GitHubContentFile {
  readonly type: "file"
  /** `base64`, or `none` for a file over 1 MB, whose `content` is then empty. */
  readonly encoding: "base64" | "none"
  readonly size: number
  readonly name: string
  /** The path from the repository root. */
  readonly path: string
  /** The file in base64, or empty for a file over 1 MB: read that one with `contents.raw()`. */
  readonly content: string
  readonly sha: string
  readonly url: string
  readonly git_url: string | null
  readonly html_url: string | null
  readonly download_url: string | null
  readonly _links: {
    readonly git: string | null
    readonly html: string | null
    readonly self: string
  }
}

/**
 * A symlink whose target is outside the repository. One pointing at a file in the same repository
 * is answered with that file's content instead.
 */
export interface GitHubContentSymlink
  extends Omit<GitHubContentFile, "type" | "encoding" | "content"> {
  readonly type: "symlink"
  readonly target: string
}

/** A submodule, which stands where a file would be. */
export interface GitHubContentSubmodule
  extends Omit<GitHubContentFile, "type" | "encoding" | "content"> {
  readonly type: "submodule"
  /** Where the submodule's own repository lives. */
  readonly submodule_git_url: string
}

/** One entry of a directory listing. */
export interface GitHubContentEntry {
  readonly type: "file" | "dir" | "symlink" | "submodule"
  readonly size: number
  readonly name: string
  readonly path: string
  readonly sha: string
  readonly url: string
  readonly git_url: string | null
  readonly html_url: string | null
  readonly download_url: string | null
}

/** What a path holds: a file, a symlink, a submodule, or a directory's entries. */
export type GitHubContent =
  | GitHubContentFile
  | GitHubContentSymlink
  | GitHubContentSubmodule
  | readonly GitHubContentEntry[]

export interface RepositoryContentsApi {
  /**
   * Read a path at a branch, tag or commit. Omit `path` for the repository root, which is a
   * directory. GitHub answers 404 for a path that is not there.
   */
  get(path?: string, options?: GetContentsOptions): Promise<GitHubContent>
  /**
   * Read a file's bytes, which is the only way to read one over 1 MB: its JSON `content` is empty.
   * A directory has no bytes, so this is for a file or a symlink.
   */
  raw(path: string, options?: GetContentsOptions): Promise<Response>
}
