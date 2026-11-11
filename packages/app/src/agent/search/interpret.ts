import { humanize } from "../bash/interpret"
import { type AgentMessages, en } from "../i18n/en"
import { memoryFile } from "../memory-paths"
import type { NormalizedTool } from "../parts"

/** What `glob` stores: the files whose path matched, sorted. */
export interface GlobOutput {
  readonly files: readonly string[]
  /** More files match than the ones listed. */
  readonly truncated: boolean
  /** The search stopped at its deadline. */
  readonly incomplete: boolean
}

export interface GrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

/** What `grep` stores: the matching lines, grouped by file in order. */
export interface GrepOutput {
  readonly matches: readonly GrepMatch[]
  /** How many files the matches are in. */
  readonly files: number
  /** Matching lines past the ones a file shows, by path. */
  readonly more: Readonly<Record<string, number>>
  /** Another file matches past the lines shown. */
  readonly truncated: boolean
  /** The search stopped at its deadline. */
  readonly incomplete: boolean
}

/**
 * Where a search looked, as the chat names it: the Agent's memory, its guides and its ontology
 * read as themselves, as `read` names their files; anywhere else is files.
 */
export type SearchPlace =
  | { readonly kind: "files" }
  | { readonly kind: "memory"; readonly project: boolean }
  | { readonly kind: "guide"; readonly name: string }
  | { readonly kind: "ontology" }

export interface SearchDescription {
  readonly place: SearchPlace
  readonly title: string
  readonly runningTitle: string
  readonly failedTitle: string
  /** What came of it, once it has a result: `8 matches in 3 files`. */
  readonly detail?: string
  /** The pattern as the call wrote it, or empty until it streams in. */
  readonly pattern: string
  /** The folder or file it looked in, as the call named it; absent for the working folder. */
  readonly path?: string
  /** The files `grep` was limited to. */
  readonly include?: string
  /** What the results leave out, in plain words. */
  readonly notes: readonly string[]
}

export interface GlobDescription extends SearchDescription {
  /** Relative to the folder searched, which the header names. */
  readonly files: readonly string[]
}

/** The matches of one file, in the order `grep` found them. */
export interface GrepGroup {
  /** Relative to the folder searched, which the header names. */
  readonly path: string
  readonly matches: readonly Omit<GrepMatch, "path">[]
  /** Matching lines past the ones shown. */
  readonly more: number
}

export interface GrepDescription extends SearchDescription {
  readonly groups: readonly GrepGroup[]
  /** The search as a regular expression, to mark where each line first matched. */
  readonly highlight?: RegExp
}

/** One run of a line's text: what the search matched, or what surrounds it. */
export interface LineSegment {
  readonly text: string
  readonly match: boolean
}

export function coerceGlobOutput(value: unknown): GlobOutput | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    !value.files.every((file) => typeof file === "string") ||
    typeof value.truncated !== "boolean"
  ) {
    return null
  }
  return { files: value.files, truncated: value.truncated, incomplete: value.incomplete === true }
}

export function coerceGrepOutput(value: unknown): GrepOutput | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.matches) ||
    !value.matches.every(isGrepMatch) ||
    typeof value.files !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    return null
  }

  const more = isRecord(value.more)
    ? Object.fromEntries(
        Object.entries(value.more).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number"
        )
      )
    : {}

  return {
    matches: value.matches,
    files: value.files,
    more,
    truncated: value.truncated,
    incomplete: value.incomplete === true,
  }
}

/** A search for files by name: `Found 12 files`, or where it looked when that has a name. */
export function describeGlob(
  tool: Pick<NormalizedTool, "input" | "output">,
  messages: AgentMessages = en
): GlobDescription {
  const m = messages.search
  const call = searchCall(tool.input)
  const output = coerceGlobOutput(tool.output)
  const place = searchPlace(call.path)
  const named = placeTitles(place, m)

  const files = output?.files ?? []
  const shown = output?.truncated ? m.moreFiles(files.length) : m.files(files.length)

  const title = named
    ? named.title
    : !output
      ? m.looked
      : output.truncated
        ? m.foundMore(files.length)
        : m.found(files.length)

  return {
    ...call,
    place,
    title,
    runningTitle: named?.running ?? m.looking,
    failedTitle: named?.failed ?? m.lookFailed,
    ...(named && output ? { detail: shown } : {}),
    notes: [
      ...(output?.truncated ? [m.truncatedFiles(files.length)] : []),
      ...(output?.incomplete ? [m.incomplete] : []),
    ],
    files: files.map((file) => underSearched(file, call.path)),
  }
}

/**
 * A search for text: `Searched for “retries” · 8 matches in 3 files`. The pattern names the step
 * only when it reads as words; a regular expression stays behind the disclosure.
 */
export function describeGrep(
  tool: Pick<NormalizedTool, "input" | "output">,
  messages: AgentMessages = en
): GrepDescription {
  const m = messages.search
  const call = searchCall(tool.input)
  const literal = isRecord(tool.input) && tool.input.literal === true
  const output = coerceGrepOutput(tool.output)
  const place = searchPlace(call.path)
  const named = placeTitles(place, m)
  const term = plainTerm(call.pattern, literal)

  const extra = Object.values(output?.more ?? {}).reduce((sum, count) => sum + count, 0)
  const total = (output?.matches.length ?? 0) + extra
  const found = !output
    ? undefined
    : total === 0
      ? m.noMatches
      : output.truncated
        ? m.moreMatches(total)
        : m.matches(total, output.files)

  const detail = named && term && found ? `${m.term(term)} · ${found}` : found
  const highlight = searchRegex(call.pattern, literal)

  return {
    ...call,
    place,
    title: named?.title ?? (term ? m.searchedFor(term) : m.searched),
    runningTitle: named?.running ?? m.searching,
    failedTitle: named?.failed ?? m.searchFailed(term),
    ...(detail ? { detail } : {}),
    notes: [
      ...(output?.truncated ? [m.truncatedMatches(output.matches.length)] : []),
      ...(output?.incomplete ? [m.incomplete] : []),
    ],
    groups: output ? grepGroups(output, call.path) : [],
    ...(highlight ? { highlight } : {}),
  }
}

/**
 * A line cut where the search first matched it, so the match can be marked. Only the first: it is
 * the work the search did on the line and finished, while matching on through the rest of the line
 * can backtrack without end on a pattern such as `(a|a)+b`, and again on every render.
 */
export function highlightLine(text: string, regex: RegExp | undefined): LineSegment[] {
  const found = regex && text ? regex.exec(text) : null

  // An empty match, as `^` or `x*` gives, marks nothing.
  if (!found || found[0].length === 0) return [{ text, match: false }]

  const start = found.index
  const end = start + found[0].length
  return [
    ...(start > 0 ? [{ text: text.slice(0, start), match: false }] : []),
    { text: text.slice(start, end), match: true },
    ...(end < text.length ? [{ text: text.slice(end), match: false }] : []),
  ]
}

/** A path's folder and its name, so the name can stand out. */
export function splitPath(path: string): { readonly folder: string; readonly name: string } {
  const cut = path.lastIndexOf("/", path.length - 2)
  return cut < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

function searchCall(input: unknown): Pick<SearchDescription, "pattern" | "path" | "include"> {
  const record = isRecord(input) ? input : {}
  const pattern = typeof record.pattern === "string" ? record.pattern : ""
  const path = givenString(record.path)
  const include = givenString(record.include)
  return {
    pattern,
    ...(path === undefined || path === "." || path === "./" ? {} : { path }),
    ...(include === undefined ? {} : { include }),
  }
}

/** A string the call gave: models send `"null"` and `"undefined"` for nothing, as the tools read. */
function givenString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" || trimmed === "null" || trimmed === "undefined" ? undefined : trimmed
}

function searchPlace(path: string | undefined): SearchPlace {
  if (!path) return { kind: "files" }

  const memory = memoryFile(path)
  if (memory) return { kind: "memory", project: memory.repo === "project" }

  const skill = path.match(/(?:^|\/)\.sixb\/agent\/skills(?:\/([^/]+))?/)
  if (skill)
    return { kind: "guide", name: skill[1] ? humanize(skill[1].replace(/^sixb-/, "")) : "" }

  if (/(?:^|\/)\.sixb\/agent\/ontology(?:\/|$)/.test(path)) return { kind: "ontology" }
  return { kind: "files" }
}

function placeTitles(
  place: SearchPlace,
  m: AgentMessages["search"]
): { readonly title: string; readonly running: string; readonly failed: string } | null {
  switch (place.kind) {
    case "memory":
      return {
        title: m.memory.title(place.project),
        running: m.memory.running(place.project),
        failed: m.memory.failed(place.project),
      }
    case "guide":
      return {
        title: m.guide.title(place.name),
        running: m.guide.running(place.name),
        failed: m.guide.failed(place.name),
      }
    case "ontology":
      return { title: m.ontology.title, running: m.ontology.running, failed: m.ontology.failed }
    default:
      return null
  }
}

const TERM_MAX = 40

/**
 * The pattern as words, when it reads as them: literal text, or a pattern with no regular
 * expression syntax past escaped punctuation. A lone `.` stays, as people write it.
 */
function plainTerm(pattern: string, literal: boolean): string | undefined {
  const unescaped = literal ? pattern : pattern.replace(/\\([^A-Za-z0-9])/g, "$1")
  if (!literal && /[\\^$*+?()[\]{}|]/.test(pattern.replace(/\\[^A-Za-z0-9]/g, ""))) {
    return undefined
  }

  const term = unescaped.replace(/\s+/g, " ").trim()
  if (!term) return undefined
  return term.length > TERM_MAX ? `${term.slice(0, TERM_MAX - 1).trimEnd()}…` : term
}

/** The regular expression `grep` ran, case included, global to find every match of a line. */
function searchRegex(pattern: string, literal: boolean): RegExp | undefined {
  if (!pattern) return undefined

  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern
  const written = literal ? pattern : pattern.replace(/\\(?:[pP]\{[^}]*\}|.)/g, "")
  // Not global: a line is matched once, as the search matched it.
  const flags = /\p{Lu}/u.test(written) ? "" : "i"

  for (const unicode of ["u", ""]) {
    try {
      return new RegExp(source, `${flags}${unicode}`)
    } catch {}
  }
  return undefined
}

function grepGroups(output: GrepOutput, searched: string | undefined): GrepGroup[] {
  const groups: { path: string; matches: Omit<GrepMatch, "path">[]; more: number }[] = []
  for (const { path: found, line, text } of output.matches) {
    const path = underSearched(found, searched)
    const last = groups.at(-1)
    if (last?.path === path) {
      last.matches.push({ line, text })
    } else {
      groups.push({ path, matches: [{ line, text }], more: output.more[found] ?? 0 })
    }
  }
  return groups
}

/**
 * A path a search found, as it reads under the search's header: relative to the folder searched,
 * which the header names once, so `.sixb/agent/ontology/` is not said before every file.
 */
function underSearched(path: string, searched: string | undefined): string {
  const folder = searched?.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  if (!folder) return path

  // The search names its matches by their real path: `/var/…` is `/private/var/…` on a Mac.
  const prefixes = folder.startsWith("/") ? [folder, `/private${folder}`] : [folder]
  const prefix = prefixes.find((candidate) => path.startsWith(`${candidate}/`))
  return prefix ? path.slice(prefix.length + 1) : path
}

function isGrepMatch(value: unknown): value is GrepMatch {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.line === "number" &&
    typeof value.text === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
