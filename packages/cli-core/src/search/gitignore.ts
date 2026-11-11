import { compilePattern, PatternError, pathPatternSource, segmentSource } from "./pattern"

/** One line of a `.gitignore`. */
export interface IgnoreRule {
  /** `!pattern`: brings back what an earlier rule excluded. */
  readonly negated: boolean
  /** `pattern/`: matches folders only. */
  readonly folderOnly: boolean
  /** No `/` but a trailing one: matches a name at any depth below the file's folder. */
  readonly anyDepth: boolean
  readonly regex: RegExp
}

/** A `.gitignore` and the folder it applies to, an absolute path. */
export interface IgnoreFile {
  readonly folder: string
  readonly rules: readonly IgnoreRule[]
}

/**
 * Parse a `.gitignore` as git reads it. A line that is not a valid pattern is skipped, as git
 * skips it.
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []

  // Git drops a UTF-8 byte order mark, which would otherwise join the first pattern.
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text

  for (const rawLine of body.split("\n")) {
    const rule = parseLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine)
    if (rule) rules.push(rule)
  }

  return rules
}

function parseLine(rawLine: string): IgnoreRule | undefined {
  // `\#` and `\!` stay escaped: the pattern compiler reads them as the characters themselves.
  if (rawLine === "" || rawLine.startsWith("#")) return undefined

  let line = withoutTrailingSpaces(rawLine)
  const negated = line.startsWith("!")
  if (negated) line = line.slice(1)

  const folderOnly = line.endsWith("/")
  line = line.replace(/\/+$/, "")

  // A `/` at the start or in the middle anchors the pattern to the file's folder.
  const anyDepth = !line.includes("/")
  line = line.replace(/^\//, "")
  if (!line) return undefined

  try {
    const regex = compilePattern(anyDepth ? segmentSource(line) : pathPatternSource(line))
    return { negated, folderOnly, anyDepth, regex }
  } catch (error) {
    if (error instanceof PatternError) return undefined
    throw error
  }
}

/** Trailing spaces are dropped, unless a backslash escapes them. */
function withoutTrailingSpaces(line: string): string {
  let end = line.length

  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0
    while (line[end - 2 - backslashes] === "\\") backslashes += 1
    if (backslashes % 2 === 1) break
    end -= 1
  }

  return line.slice(0, end)
}

/**
 * Whether the `.gitignore` files that apply exclude an entry, given as an absolute path. Files
 * come from the outermost folder in, and a later rule wins over an earlier one, so a deeper file
 * overrides its parents. What lies inside an excluded folder is never asked about: the walk does
 * not enter it, so a rule cannot bring it back, as in git.
 */
export function isIgnored(files: readonly IgnoreFile[], path: string, isFolder: boolean): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1)
  let ignored = false

  for (const file of files) {
    const prefix = file.folder.endsWith("/") ? file.folder : `${file.folder}/`
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)

    for (const rule of file.rules) {
      if (rule.folderOnly && !isFolder) continue
      // Only a rule that would change the verdict so far needs testing.
      if (rule.negated !== ignored) continue
      if (rule.regex.test(rule.anyDepth ? name : relative)) ignored = !rule.negated
    }
  }

  return ignored
}
