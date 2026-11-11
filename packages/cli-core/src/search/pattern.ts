/**
 * Path patterns, as `glob` and `.gitignore` write them: `*` and `?` within a name, `[abc]`,
 * `[!abc]` and `[^abc]`, `**` as a whole segment for any number of folders, `\` to escape.
 * `{a,b}` belongs to `glob` alone and is expanded before compiling ({@link expandBraces}).
 */

/** More alternatives than any real pattern names: past it, `{…}` is a mistake. */
const MAX_ALTERNATIVES = 256

export class PatternError extends Error {}

/** A pattern's regular expression source, for a whole path relative to where it applies. */
export function pathPatternSource(pattern: string): string {
  const segments = pattern.split("/")
  let source = ""

  segments.forEach((segment, index) => {
    const last = index === segments.length - 1

    if (segment === "**") {
      // `a/**` is everything inside a; `**/b` and `a/**/b` cross any number of folders.
      source += last ? ".*" : "(?:[^/]*/)*"
      return
    }

    source += segmentSource(segment)
    if (!last) source += "/"
  })

  return source
}

/** One name's source: never crosses a `/`. */
export function segmentSource(segment: string): string {
  let source = ""

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] as string

    if (char === "\\") {
      index += 1
      source += escapeRegExp(segment[index] ?? "\\")
    } else if (char === "*") {
      while (segment[index + 1] === "*") index += 1
      source += "[^/]*"
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "[") {
      const parsed = characterClass(segment, index)
      if (parsed) {
        source += parsed.source
        index = parsed.end
      } else {
        source += "\\["
      }
    } else {
      source += escapeRegExp(char)
    }
  }

  return source
}

/** `[...]` from `start`, or nothing when it never closes and is a literal `[`. */
function characterClass(
  segment: string,
  start: number
): { readonly source: string; readonly end: number } | undefined {
  let index = start + 1
  const negated = segment[index] === "!" || segment[index] === "^"
  if (negated) index += 1

  let body = ""
  // A `]` right after the opening is part of the class.
  if (segment[index] === "]") {
    body += "\\]"
    index += 1
  }

  for (; index < segment.length; index += 1) {
    const char = segment[index] as string

    if (char === "]") {
      return { source: negated ? `[^/${body}]` : `[${body}]`, end: index }
    }
    if (char === "\\" && index + 1 < segment.length) {
      index += 1
      body += escapeClassChar(segment[index] as string)
    } else {
      body += char === "-" ? "-" : escapeClassChar(char)
    }
  }

  return undefined
}

/**
 * Expand `{a,b}` into its alternatives, nested ones included. A brace without a comma, or that
 * never closes, is a literal brace.
 */
export function expandBraces(pattern: string): string[] {
  const expanded: string[] = []
  expandInto(pattern, expanded)
  return expanded
}

function expandInto(pattern: string, into: string[]): void {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]

    if (char === "\\") {
      index += 1
      continue
    }
    if (char !== "{") continue

    const group = braceGroup(pattern, index)
    if (!group) continue

    const prefix = pattern.slice(0, index)
    const suffix = pattern.slice(group.end + 1)
    for (const option of group.options) expandInto(`${prefix}${option}${suffix}`, into)
    return
  }

  if (into.length >= MAX_ALTERNATIVES) {
    throw new PatternError(`it names more than ${MAX_ALTERNATIVES} alternatives with {…}`)
  }
  into.push(pattern)
}

/** The `{…}` opening at `start`: its options split on top-level commas, and its closing index. */
function braceGroup(
  pattern: string,
  start: number
): { readonly options: string[]; readonly end: number } | undefined {
  const options: string[] = []
  let depth = 0
  let optionStart = start + 1

  for (let index = start + 1; index < pattern.length; index += 1) {
    const char = pattern[index]

    if (char === "\\") {
      index += 1
    } else if (char === "{") {
      depth += 1
    } else if (char === "}" && depth > 0) {
      depth -= 1
    } else if (char === "," && depth === 0) {
      options.push(pattern.slice(optionStart, index))
      optionStart = index + 1
    } else if (char === "}") {
      if (options.length === 0) return undefined
      options.push(pattern.slice(optionStart, index))
      return { options, end: index }
    }
  }

  return undefined
}

/** Compile a regular expression source, or say why the pattern is not one. */
export function compilePattern(source: string, flags = ""): RegExp {
  try {
    return new RegExp(`^${source}$`, flags)
  } catch (error) {
    throw new PatternError(error instanceof Error ? error.message : String(error))
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

function escapeClassChar(char: string): string {
  return /[\\\]^[-]/.test(char) ? `\\${char}` : char
}
