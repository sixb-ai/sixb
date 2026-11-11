import { Buffer } from "node:buffer"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"
import type { IgnoreFile } from "./gitignore"
import { compileGlob, type GlobMatcher } from "./glob"
import { PatternError } from "./pattern"
import { childPath, FileWalk, readIgnoreFile, type WalkedFile } from "./walk"

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

export function globFiles(request: GlobSearchRequest, workingDirectory: string): GlobSearchResult {
  const scope = resolveScope(request, workingDirectory)
  const matcher = compileGlobOrFail(request.pattern, "invalid_pattern")
  if (scope.file) throw new SearchError("path_is_file", "The path is a file.")

  const walk = scope.walk(matcher, matcher.namesHidden)
  const files: string[] = []
  let truncated = false

  for (const file of walk.files()) {
    if (!matcher.matches(file.relative)) continue
    if (files.length === SEARCH_LIMITS.files) {
      truncated = true
      break
    }
    files.push(scope.display(file.path))
  }

  return { files, truncated, ...(walk.incomplete ? { incomplete: true as const } : {}) }
}

export function grepFiles(request: GrepSearchRequest, workingDirectory: string): GrepSearchResult {
  const scope = resolveScope(request, workingDirectory)
  const matchLine = lineMatcher(request.pattern, request.literal === true)
  const include =
    request.include === undefined
      ? undefined
      : compileGlobOrFail(request.include, "invalid_include")

  // A file named as the path is searched alone, whatever include says.
  const walk = scope.file ? undefined : scope.walk(include, true)
  const candidates: Iterable<WalkedFile> = walk
    ? walk.files()
    : [{ path: scope.target, relative: basename(scope.target), symlink: false }]

  const matches: GrepMatch[] = []
  const more: Record<string, number> = {}
  let files = 0
  let textBytes = 0
  let textFull = false
  let truncated = false
  let stopped = false

  for (const file of candidates) {
    if (include && walk && !include.matches(file.relative)) continue
    if (file.symlink && !scope.holds(file.path)) continue

    const read = readText(file.path, walk === undefined)
    if (!("text" in read)) {
      // A file named as the path says why it was not searched, rather than "No matches".
      if (walk === undefined && read.skipped !== "unreadable") throw unsearchedError(read.skipped)
      continue
    }

    const path = scope.display(file.path)
    let shown = 0
    let counted = 0

    for (const [index, line] of lines(read.text).entries()) {
      // One file can hold enough lines, or slow enough ones, to outlast the deadline alone.
      if (Date.now() >= scope.deadline) {
        stopped = true
        break
      }
      const match = matchLine(line)
      if (match === undefined) continue

      const text = cutLine(line, match)
      const bytes =
        Buffer.byteLength(`  ${index + 1}: ${text}\n`) +
        (shown === 0 ? Buffer.byteLength(`${path}\n\n`) : 0)
      if (textBytes + bytes > SEARCH_LIMITS.textBytes) textFull = true
      const full = textFull || matches.length === SEARCH_LIMITS.lines

      if (shown === 0 && full) {
        truncated = true
        break
      }
      if (shown > 0 && (shown === SEARCH_LIMITS.linesPerFile || full)) {
        counted += 1
        continue
      }

      matches.push({ path, line: index + 1, text })
      textBytes += bytes
      shown += 1
    }

    if (shown > 0) files += 1
    if (counted > 0) more[path] = counted
    if (truncated || stopped) break
  }

  return {
    matches,
    files,
    ...(Object.keys(more).length > 0 ? { more } : {}),
    truncated,
    ...(walk?.incomplete || stopped ? { incomplete: true as const } : {}),
  }
}

interface SearchScope {
  /** The real path searched. */
  readonly target: string
  /** The target is a file. */
  readonly file: boolean
  /** The time, in epoch milliseconds, at which the search stops with what it found. */
  readonly deadline: number
  /** Whether a path's target lies in the run's roots. */
  holds(path: string): boolean
  display(path: string): string
  walk(matcher: GlobMatcher | undefined, hidden: boolean): FileWalk
}

/**
 * Where a search starts, confined to the working directory and the run's context directory once
 * links are resolved, as `read` confines a path.
 */
function resolveScope(request: SearchScopeRequest, workingDirectory: string): SearchScope {
  const deadline = Date.now() + request.timeoutMs
  const working = realpathSync(workingDirectory)
  const context =
    request.contextDirectory === undefined
      ? undefined
      : realPath(resolve(working, request.contextDirectory))

  const target = realPath(resolve(working, request.path ?? "."))
  if (target === undefined) throw new SearchError("path_missing", "The path does not exist.")

  // The context directory may sit inside the working directory: the closer root is the one used.
  const root =
    context !== undefined && isWithin(target, context)
      ? context
      : isWithin(target, working)
        ? working
        : undefined
  if (root === undefined) {
    throw new SearchError("path_outside", "The path is outside the run's folders.")
  }

  const stats = statSync(target)
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new SearchError("path_not_searchable", "The path is not a file or a folder.")
  }

  const holds = (path: string): boolean => {
    const real = realPath(path)
    return (
      real !== undefined &&
      (isWithin(real, working) || (context !== undefined && isWithin(real, context)))
    )
  }

  const display = (path: string): string =>
    isWithin(path, working) ? relative(working, path) || "." : path

  const walk = (matcher: GlobMatcher | undefined, hidden: boolean): FileWalk => {
    const namesNodeModules = relative(root, target).split("/").includes("node_modules")
    return new FileWalk({
      root: target,
      ignoreFiles: [...repositoryIgnoreFiles(root), ...ancestorIgnoreFiles(root, target)],
      hidden,
      nodeModules: namesNodeModules || matcher?.namesNodeModules === true,
      skipFolders: new Set(context !== undefined && !isWithin(target, context) ? [context] : []),
      ...(matcher ? { mayContain: (folder: string) => matcher.mayContain(folder) } : {}),
      deadline,
    })
  }

  return { target, file: stats.isFile(), deadline, holds, display, walk }
}

/** How far above a root the git repository it lies in is looked for. */
const REPOSITORY_LEVELS = 20

/**
 * The ignore rules of the git repository a root lies in, from above the root: its
 * `.git/info/exclude`, then the `.gitignore` of each folder from the repository's top down to the
 * folder above the root, as git applies them. Only those files are read; nothing outside the
 * roots is walked. A root outside any repository gets none.
 */
function repositoryIgnoreFiles(root: string): IgnoreFile[] {
  const above: string[] = []
  let folder = root

  for (let level = 0; level <= REPOSITORY_LEVELS; level += 1) {
    if (holdsGit(folder)) {
      const exclude = readIgnoreFile(folder, ".git/info/exclude")
      return [
        ...(exclude ? [exclude] : []),
        ...above.flatMap((parent) => readIgnoreFile(parent) ?? []),
      ]
    }

    const parent = dirname(folder)
    if (parent === folder) return []
    folder = parent
    above.unshift(folder)
  }

  return []
}

/** A folder holding `.git`: a repository's top, or a worktree's, where `.git` is a file. */
function holdsGit(folder: string): boolean {
  try {
    lstatSync(childPath(folder, ".git"))
    return true
  } catch {
    return false
  }
}

/** The `.gitignore` files from the root down to the folder above the target, outermost first. */
function ancestorIgnoreFiles(root: string, target: string): IgnoreFile[] {
  if (target === root) return []

  const folders: string[] = []
  for (let folder = dirname(target); isWithin(folder, root); folder = dirname(folder)) {
    folders.unshift(folder)
    if (folder === root) break
  }

  return folders.flatMap((folder) => readIgnoreFile(folder) ?? [])
}

/** Where a line first matched `grep`'s pattern, in UTF-16 units. */
interface LineMatch {
  readonly index: number
  readonly length: number
}

/**
 * Where a line first matches `grep`'s pattern, over its first
 * {@link SEARCH_LIMITS.matchCharacters} characters. Case is smart: ignored when the pattern has no
 * uppercase letter. Literal text is a plain substring search, which no line can slow down.
 */
function lineMatcher(pattern: string, literal: boolean): (line: string) => LineMatch | undefined {
  if (literal) {
    const ignoreCase = !/\p{Lu}/u.test(pattern)
    const needle = ignoreCase ? pattern.toLowerCase() : pattern

    return (line) => {
      const matched = linePrefix(line, SEARCH_LIMITS.matchCharacters)
      const index = (ignoreCase ? matched.toLowerCase() : matched).indexOf(needle)
      // Lowercasing lengthens a few characters (İ): the index is then near the match, not on it.
      return index < 0 ? undefined : { index: Math.min(index, line.length), length: needle.length }
    }
  }

  const regex = lineRegex(pattern)
  return (line) => {
    const found = regex.exec(linePrefix(line, SEARCH_LIMITS.matchCharacters))
    return found ? { index: found.index, length: found[0].length } : undefined
  }
}

/**
 * Unicode mode first, so `\p{…}` works; without it when that refuses what plain mode accepts.
 */
function lineRegex(pattern: string): RegExp {
  const written = pattern.replace(/\\(?:[pP]\{[^}]*\}|.)/g, "")
  const flags = /\p{Lu}/u.test(written) ? "" : "i"

  try {
    return new RegExp(pattern, `${flags}u`)
  } catch {}

  try {
    return new RegExp(pattern, flags)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SearchError(
      "invalid_pattern",
      message.replace(/^Invalid regular expression: (?:\/.*\/[a-z]*: )?/, "")
    )
  }
}

function compileGlobOrFail(pattern: string, code: SearchErrorCode): GlobMatcher {
  try {
    return compileGlob(pattern)
  } catch (error) {
    if (error instanceof PatternError) throw new SearchError(code, error.message)
    throw error
  }
}

type FileText =
  | { readonly text: string }
  | { readonly skipped: "binary" | "too_large" | "unreadable" }

/**
 * A file's text, unless it is binary, too large or unreadable. A file found by the walk is read
 * as UTF-8 leniently, so a mostly ASCII file in another encoding still matches; a file named as
 * the path must be UTF-8 text.
 */
function readText(path: string, strict: boolean): FileText {
  try {
    if (statSync(path).size > SEARCH_LIMITS.fileBytes) return { skipped: "too_large" }

    const bytes = readFileSync(path)
    if (bytes.subarray(0, SEARCH_LIMITS.binaryProbeBytes).includes(0)) return { skipped: "binary" }
    if (!strict) return { text: bytes.toString("utf8") }

    try {
      return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }
    } catch {
      return { skipped: "binary" }
    }
  } catch {
    return { skipped: "unreadable" }
  }
}

function unsearchedError(reason: "binary" | "too_large"): SearchError {
  return reason === "binary"
    ? new SearchError("file_binary", "The file is binary, or not UTF-8 text.")
    : new SearchError("file_too_large", "The file is over 10 MiB.")
}

function lines(text: string): string[] {
  const split = text.split("\n")
  if (split.at(-1) === "") split.pop()
  return split.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
}

/**
 * A line as `grep` shows it: whole when it fits, else cut to {@link SEARCH_LIMITS.lineCharacters}
 * characters around its first match, so a match far into a minified line is still seen. A cut
 * never splits a character written as two units.
 */
function cutLine(line: string, match: LineMatch): string {
  const budget = SEARCH_LIMITS.lineCharacters
  if (line.length <= budget) return line

  // The window opens a little before the match, or ends with the line, the leading `…` in the
  // budget; a match within the line's first characters keeps its start.
  const room = budget - 1
  const start =
    match.index + match.length <= budget
      ? 0
      : Math.max(0, Math.min(match.index - SEARCH_LIMITS.matchLead, line.length - room))
  if (start === 0) return `${linePrefix(line, budget)}…`

  const from = isLowSurrogate(line.charCodeAt(start)) ? start + 1 : start
  // One unit past the room, so a character the room would split is seen and left out.
  const window = linePrefix(line.slice(from, from + room + 1), room)

  return `…${window}${from + window.length < line.length ? "…" : ""}`
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** A line's first `length` UTF-16 units, never half of a character written as two. */
function linePrefix(line: string, length: number): string {
  if (line.length <= length) return line

  const code = line.charCodeAt(length - 1)
  return line.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length)
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
}
