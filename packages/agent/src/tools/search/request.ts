/**
 * What `search.mjs` takes and prints: the contract between the `glob` and `grep` tools and the
 * engine the run installs.
 */

/** How much a search returns, and which files `grep` reads. */
export const SEARCH_LIMITS = {
  files: 100,
  lines: 100,
  linesPerFile: 20,
  lineCharacters: 500,
  /** How much of a cut line shows before its first match. */
  matchLead: 40,
  /**
   * How much of a line `grep` matches. A backtracking regex can take seconds on one long line of a
   * minified file; past this, a match is missed rather than the search stalled.
   */
  matchCharacters: 4_000,
  /** What `grep`'s matches may add to its model text, in UTF-8 bytes, before it is truncated. */
  textBytes: 24 * 1024,
  fileBytes: 10 * 1024 * 1024,
  /** A NUL byte in this many first bytes makes a file binary. */
  binaryProbeBytes: 8 * 1024,
} as const

interface SearchScopeRequest {
  /** Relative to the working directory, or absolute. Default: the working directory. */
  readonly path?: string
  /**
   * The run's context directory: the second root a search may start from. A search that starts
   * outside it never enters it.
   */
  readonly contextDirectory?: string
  /** How long the walk may take before it stops with what it found. */
  readonly timeoutMs: number
}

export interface GlobSearchRequest extends SearchScopeRequest {
  readonly tool: "glob"
  readonly pattern: string
}

export interface GrepSearchRequest extends SearchScopeRequest {
  readonly tool: "grep"
  /** A JavaScript regular expression, or the text itself with `literal`. */
  readonly pattern: string
  /** A `glob` pattern the files searched must match. */
  readonly include?: string
  readonly literal?: boolean
}

export type SearchRequest = GlobSearchRequest | GrepSearchRequest

/**
 * Paths are relative to the working directory when they are under it, absolute otherwise.
 * `incomplete` says the walk stopped at its deadline.
 */
export interface GlobSearchResult {
  readonly files: string[]
  readonly truncated: boolean
  readonly incomplete?: true
}

export interface GrepMatch {
  readonly path: string
  /** One-based. */
  readonly line: number
  readonly text: string
}

export interface GrepSearchResult {
  readonly matches: GrepMatch[]
  /** How many files the matches are in. */
  readonly files: number
  /** Matching lines counted past what a file shows, by path. */
  readonly more?: Record<string, number>
  /** Another file matches past the cap. */
  readonly truncated: boolean
  readonly incomplete?: true
}

export type SearchErrorCode =
  | "path_missing"
  | "path_outside"
  | "path_is_file"
  | "path_not_searchable"
  | "invalid_pattern"
  | "invalid_include"
  | "file_binary"
  | "file_too_large"

/** A search that cannot run as asked: the caller says why in its own words. */
export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string
  ) {
    super(message)
    this.name = "SearchError"
  }
}
