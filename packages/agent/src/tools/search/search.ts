import { Buffer } from "node:buffer"
import { lstatSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"
import type { IgnoreFile } from "./gitignore"
import { compileGlob, type GlobMatcher } from "./glob"
import { cutLine, lines, textMatcher } from "./match"
import { PatternError } from "./pattern"
import { type FileText, openText, ReadAhead } from "./read"
import {
  type GlobSearchRequest,
  type GlobSearchResult,
  type GrepMatch,
  type GrepSearchRequest,
  type GrepSearchResult,
  SEARCH_LIMITS,
  SearchError,
  type SearchErrorCode,
  type SearchRequest,
} from "./request"
import { childPath, FileWalk, readIgnoreFile, type WalkedFile } from "./walk"

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

export async function grepFiles(
  request: GrepSearchRequest,
  workingDirectory: string
): Promise<GrepSearchResult> {
  const scope = resolveScope(request, workingDirectory)
  const matcher = textMatcher(request.pattern, request.literal === true)
  const include =
    request.include === undefined
      ? undefined
      : compileGlobOrFail(request.include, "invalid_include")

  // A file named as the path is searched alone, whatever include says.
  const walk = scope.file ? undefined : scope.walk(include, true)
  const searched = function* (): Generator<WalkedFile> {
    if (!walk) {
      yield { path: scope.target, relative: basename(scope.target), symlink: false }
      return
    }

    for (const file of walk.files()) {
      if (include && !include.matches(file.relative)) continue
      if (file.symlink && !scope.holds(file.path)) continue
      yield file
    }
  }
  // Files are read ahead of the one searched, and come back in the walk's order.
  const reads = new ReadAhead(
    searched(),
    (file: WalkedFile) => openText(file.path, walk === undefined),
    (read: FileText) => !("text" in read)
  )

  const matches: GrepMatch[] = []
  const more: Record<string, number> = {}
  let files = 0
  let textBytes = 0
  let textFull = false
  let truncated = false
  let stopped = false

  try {
    for (let next = await reads.next(); next; next = await reads.next()) {
      const { item: file, read } = next

      if (!("text" in read)) {
        // A file named as the path says why it was not searched, rather than "No matches".
        if (walk === undefined && read.skipped !== "unreadable") throw unsearchedError(read.skipped)
        continue
      }

      // Most files hold no match: one test of the whole text spares splitting them into lines.
      if (!matcher.mayMatch(read.text)) continue

      const path = scope.display(file.path)
      let shown = 0
      let counted = 0

      for (const [index, line] of lines(read.text).entries()) {
        // One file can hold enough lines, or slow enough ones, to outlast the deadline alone.
        if (Date.now() >= scope.deadline) {
          stopped = true
          break
        }
        const match = matcher.line(line)
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
  } finally {
    await reads.stop()
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
function resolveScope(request: SearchRequest, workingDirectory: string): SearchScope {
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

function compileGlobOrFail(pattern: string, code: SearchErrorCode): GlobMatcher {
  try {
    return compileGlob(pattern)
  } catch (error) {
    if (error instanceof PatternError) throw new SearchError(code, error.message)
    throw error
  }
}

function unsearchedError(reason: "binary" | "too_large"): SearchError {
  return reason === "binary"
    ? new SearchError("file_binary", "The file is binary, or not UTF-8 text.")
    : new SearchError("file_too_large", "The file is over 10 MiB.")
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
