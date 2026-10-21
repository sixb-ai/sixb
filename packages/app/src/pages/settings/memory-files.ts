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

/**
 * The Markdown with each `[[link]]` to a file of the repo written as a Markdown link to it, named
 * after the file. A link to a file the repo does not hold reads as its plain name.
 */
export function linkMemoryFiles(
  markdown: string,
  paths: ReadonlySet<string>,
  href: (path: string) => string,
  label: (path: string) => string
): string {
  return markdown.replace(/\[\[([^[\]\n]+)\]\]/g, (_, link: string) => {
    const path = memoryLinkPath(link.trim())
    const name = label(path).replace(/[[\]]/g, "")
    return paths.has(path) ? `[${name}](${href(path)})` : name
  })
}

/** A file as a link names it: its own name, without its folders or `.md`. */
export function memoryLinkName(path: string): string {
  return memoryFileName(path.slice(path.lastIndexOf("/") + 1))
}

/** A file as the page names it: its path, with `.md` left out. */
export function memoryFileName(path: string): string {
  return path.replace(/\.md$/, "")
}

/** One row of the file tree: a folder, once, before what is in it, or a file under its folder. */
export interface MemoryTreeRow {
  readonly kind: "folder" | "file"
  readonly path: string
  readonly name: string
  readonly depth: number
}

/** The files as a tree, in the order of `paths`, each folder shown once above its files. */
export function memoryTree(paths: readonly string[]): MemoryTreeRow[] {
  const rows: MemoryTreeRow[] = []
  let previous: string[] = []
  for (const path of paths) {
    const segments = path.split("/")
    const folders = segments.slice(0, -1)
    let shared = 0
    while (shared < folders.length && folders[shared] === previous[shared]) shared += 1
    for (let depth = shared; depth < folders.length; depth += 1) {
      rows.push({
        kind: "folder",
        path: folders.slice(0, depth + 1).join("/"),
        name: folders[depth] ?? "",
        depth,
      })
    }
    rows.push({
      kind: "file",
      path,
      name: memoryFileName(segments.at(-1) ?? path),
      depth: folders.length,
    })
    previous = folders
  }
  return rows
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
