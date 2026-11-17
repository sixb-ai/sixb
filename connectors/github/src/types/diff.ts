/** How a file changed between two commits. */
export type GitHubDiffStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged"

/**
 * One file a diff changes, as GitHub describes it to a pull request and to a comparison.
 * `patch` is the unified diff, hunk headers included; GitHub leaves it out when it will not render
 * one, such as for a binary file, and then the file itself has to be read.
 */
export interface GitHubDiffEntry {
  /** The file blob's SHA, or `null` for a submodule. */
  readonly sha: string | null
  readonly filename: string
  readonly status: GitHubDiffStatus
  /** The name it had before a rename or a copy. */
  readonly previous_filename?: string
  readonly additions: number
  readonly deletions: number
  readonly changes: number
  readonly blob_url: string
  readonly raw_url: string
  readonly contents_url: string
  readonly patch?: string
}
