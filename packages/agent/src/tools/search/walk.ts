import { Buffer } from "node:buffer"
import { type Dirent, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import { type IgnoreFile, isIgnored, parseGitignore } from "./gitignore"

export interface WalkOptions {
  /** The folder to walk: a real, absolute path. */
  readonly root: string
  /** The `.gitignore` files of the folders above the root that apply, outermost first. */
  readonly ignoreFiles: readonly IgnoreFile[]
  /** Enter folders and list files whose name starts with `.`. */
  readonly hidden: boolean
  readonly nodeModules: boolean
  /** Real, absolute paths of folders never entered: the run's context directory. */
  readonly skipFolders: ReadonlySet<string>
  /** Whether a folder, relative to the root, may hold what the search looks for. */
  readonly mayContain?: (relativeFolder: string) => boolean
  /** The time, in epoch milliseconds, at which the walk stops. */
  readonly deadline: number
}

export interface WalkedFile {
  readonly path: string
  /** From the root, with `/`. */
  readonly relative: string
  /** A link to a file: listed, but its target may be anywhere. */
  readonly symlink: boolean
}

/**
 * The files under a folder, in byte order of their paths, so that the first results of a capped
 * search are the same on every run. `.git`, hidden entries and `node_modules` unless asked for,
 * what `.gitignore` files exclude, and unreadable entries are skipped. Links to folders are not
 * followed. Past its deadline, the walk stops and says it is {@link incomplete}.
 */
export class FileWalk {
  #incomplete = false

  constructor(private readonly options: WalkOptions) {}

  get incomplete(): boolean {
    return this.#incomplete
  }

  *files(): Generator<WalkedFile> {
    yield* this.#folder(this.options.root, "", this.options.ignoreFiles)
  }

  *#folder(
    folder: string,
    relativeFolder: string,
    ignoreFiles: readonly IgnoreFile[]
  ): Generator<WalkedFile> {
    if (this.#pastDeadline()) return

    let entries: Dirent[]
    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }

    const own = entries.some((entry) => entry.name === ".gitignore")
      ? readIgnoreFile(folder)
      : undefined
    const applying = own ? [...ignoreFiles, own] : ignoreFiles

    for (const entry of sortedEntries(entries)) {
      if (this.#incomplete) return

      const { name } = entry
      if (name === ".git") continue
      if (!this.options.hidden && name.startsWith(".")) continue

      const path = childPath(folder, name)
      const relative = relativeFolder ? `${relativeFolder}/${name}` : name

      if (entry.isDirectory()) {
        if (name === "node_modules" && !this.options.nodeModules) continue
        if (this.options.skipFolders.has(path)) continue
        if (isIgnored(applying, path, true)) continue
        if (this.options.mayContain && !this.options.mayContain(relative)) continue

        yield* this.#folder(path, relative, applying)
        continue
      }

      const symlink = entry.isSymbolicLink()
      if (!entry.isFile() && !(symlink && isLinkToFile(path))) continue
      if (isIgnored(applying, path, false)) continue
      if (this.#pastDeadline()) return

      yield { path, relative, symlink }
    }
  }

  #pastDeadline(): boolean {
    if (Date.now() >= this.options.deadline) this.#incomplete = true
    return this.#incomplete
  }
}

/** Past this size, an ignore file is not read. */
const IGNORE_FILE_BYTES = 1024 * 1024

/**
 * A folder's `.gitignore`, or another ignore file applying from it, when it is a regular file it
 * can read. A link is not followed, as git does not, and a device or a FIFO is never opened.
 */
export function readIgnoreFile(folder: string, name = ".gitignore"): IgnoreFile | undefined {
  try {
    const path = childPath(folder, name)
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size > IGNORE_FILE_BYTES) return undefined

    return { folder, rules: parseGitignore(readFileSync(path, "utf8")) }
  } catch {
    return undefined
  }
}

/**
 * Entries in the order their paths sort in, byte by byte: a folder as its name and a `/`, so that
 * `a.txt` comes before `a/b.txt` as it does in a sorted list of paths.
 */
function sortedEntries(entries: readonly Dirent[]): Dirent[] {
  return entries
    .map((entry) => ({
      entry,
      key: Buffer.from(entry.isDirectory() ? `${entry.name}/` : entry.name),
    }))
    .sort((left, right) => Buffer.compare(left.key, right.key))
    .map(({ entry }) => entry)
}

export function childPath(folder: string, name: string): string {
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`
}

function isLinkToFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
