import type { GetAgentMemoryResponse } from "@sixb/client"
import { getAgentMemoryQueryKey, listAgentMemoryRevisionsQueryKey } from "@sixb/client/hooks"
import type { QueryClient } from "@tanstack/react-query"

/** The memory repos a person sees on the Memory page, in tab order. */
export const MEMORY_REPOS = ["user", "project"] as const

export type MemoryRepo = (typeof MEMORY_REPOS)[number]

/** The file every conversation reads first. */
export const MEMORY_ENTRY = "MEMORY.md"

/**
 * The page's address for a scope, its history, or one of its notes, so links, the tabs and
 * reloads agree. The person's own memories need no parameter.
 */
export function memoryPageHref(target: {
  readonly repo: MemoryRepo
  readonly file?: string
  readonly history?: boolean
}): string {
  const params = new URLSearchParams()
  if (target.repo !== "user") params.set("repo", target.repo)
  if (target.history) params.set("view", "history")
  if (target.file && target.file !== MEMORY_ENTRY) params.set("file", target.file)
  const query = params.toString()
  return query ? `?${query}` : "?"
}

/** The page's address for one file of a repo. */
export function memoryFileHref(repo: MemoryRepo, path: string): string {
  return memoryPageHref({ repo, file: path })
}

/** `MEMORY.md` first, then every other file by path, so a folder's files sit together. */
export function sortMemoryPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) =>
    left === MEMORY_ENTRY ? -1 : right === MEMORY_ENTRY ? 1 : left.localeCompare(right)
  )
}

/** The folder a file sits in, `""` at the repo's root. */
export function memoryFolder(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

/** The file a `[[link]]` names, as Core reads it: `.md` unless its last segment has an extension. */
export function memoryLinkPath(link: string): string {
  const name = link.slice(link.lastIndexOf("/") + 1)
  return name.includes(".") ? link : `${link}.md`
}

/** A file as a link names it: its own name, without its folders or `.md`. */
export function memoryLinkName(path: string): string {
  return memoryFileName(path.slice(path.lastIndexOf("/") + 1))
}

/** A file as the page names it: its path, with `.md` left out. */
export function memoryFileName(path: string): string {
  return path.replace(/\.md$/, "")
}

/** Whether a file is Markdown, which the page reads as text, or another file read as code. */
export function isMemoryNote(path: string): boolean {
  return path.endsWith(".md")
}

export interface MemoryDiffLine {
  readonly kind: "same" | "added" | "removed"
  readonly text: string
}

/** Beyond this many line pairs, the lines between the shared start and end count as replaced. */
const MAX_DIFF_CELLS = 2_000_000

/** The lines `after` removes from `before` and the ones it adds, in order, with those kept. */
export function memoryLineDiff(before: string, after: string): MemoryDiffLine[] {
  const old = splitLines(before)
  const next = splitLines(after)
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1
  let end = 0
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1
  }
  const same = (lines: readonly string[]) => lines.map((text) => ({ kind: "same" as const, text }))
  const removedMiddle = old.slice(start, old.length - end)
  const addedMiddle = next.slice(start, next.length - end)
  return [
    ...same(old.slice(0, start)),
    ...middleDiff(removedMiddle, addedMiddle),
    ...same(old.slice(old.length - end)),
  ]
}

/** The longest common subsequence of two runs of lines, read back as a diff. */
function middleDiff(old: readonly string[], next: readonly string[]): MemoryDiffLine[] {
  if (old.length * next.length > MAX_DIFF_CELLS) {
    return [
      ...old.map((text) => ({ kind: "removed" as const, text })),
      ...next.map((text) => ({ kind: "added" as const, text })),
    ]
  }
  const width = next.length + 1
  const lengths = new Uint32Array((old.length + 1) * width)
  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = next.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        old[i] === next[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0)
    }
  }
  const lines: MemoryDiffLine[] = []
  let i = 0
  let j = 0
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      lines.push({ kind: "same", text: old[i] ?? "" })
      i += 1
      j += 1
    } else if (
      i < old.length &&
      (j === next.length ||
        (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
    ) {
      // A replaced line reads as the old one, then the new one.
      lines.push({ kind: "removed", text: old[i] ?? "" })
      i += 1
    } else {
      lines.push({ kind: "added", text: next[j] ?? "" })
      j += 1
    }
  }
  return lines
}

function splitLines(text: string): string[] {
  if (text === "") return []
  return text.replace(/\n$/, "").split("\n")
}

export type MemoryRepoView = GetAgentMemoryResponse
export type MemoryFile = MemoryRepoView["files"][number]

/** A note's title: its `# heading`, or its name in words; the main memory's has a name of its own. */
export function noteTitle(
  file: { readonly path: string; readonly contents: string },
  messages: { readonly mainMemory: string }
): string {
  const heading = file.contents.match(/^\s*#[ \t]+(.+?)\s*$/m)
  if (heading?.[1] && file.contents.trimStart().startsWith("#")) return heading[1]
  if (file.path === MEMORY_ENTRY) return messages.mainMemory
  return words(memoryFileName(file.path.slice(file.path.lastIndexOf("/") + 1)))
}

/** `harbor-foods` as "Harbor foods". */
export function words(name: string): string {
  const spaced = name.replace(/[-_]+/g, " ").trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The date an entry ends with, which the page reads apart from the entry. */
export const ADDED = /\s*\(added (\d{4}-\d{2}-\d{2})\)\s*$/

/** Reload the repo, every revision of it read for the history, and its history. */
export function refreshMemory(queryClient: QueryClient, repo: MemoryRepo) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getAgentMemoryQueryKey({ path: { repo } }) }),
    queryClient.invalidateQueries({
      queryKey: listAgentMemoryRevisionsQueryKey({ path: { repo } }),
    }),
  ])
}
