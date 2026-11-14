import {
  compilePattern,
  expandBraces,
  PatternError,
  pathPatternSource,
  segmentSource,
} from "./pattern"

/**
 * A `glob` pattern, matched against paths relative to where the search starts. A pattern without
 * `/` matches a name at any depth (`*.md` finds every Markdown file), as in `.gitignore`; one with
 * `/` matches from the start, with `**` for any number of folders.
 */
export interface GlobMatcher {
  matches(relativePath: string): boolean
  /** Whether a folder, relative to where the search starts, may hold a match. */
  mayContain(relativeFolder: string): boolean
  /** A segment starts with `.`: the pattern looks for hidden files. */
  readonly namesHidden: boolean
  readonly namesNodeModules: boolean
}

interface Alternative {
  /** Matched against the name alone, at any depth. */
  readonly anyDepth: boolean
  readonly regex: RegExp
  readonly segments: readonly string[]
}

export function compileGlob(pattern: string): GlobMatcher {
  const alternatives = expandBraces(pattern).map(compileAlternative)
  const segments = alternatives.flatMap((alternative) => alternative.segments)
  const folderSegments = new Map<string, RegExp>()

  // One folder segment against one pattern segment, compiled once for the whole walk.
  const segmentMatches = (patternSegment: string, name: string): boolean => {
    let regex = folderSegments.get(patternSegment)
    if (!regex) {
      regex = compilePattern(segmentSource(patternSegment))
      folderSegments.set(patternSegment, regex)
    }
    return regex.test(name)
  }

  return {
    matches(relativePath) {
      const name = relativePath.slice(relativePath.lastIndexOf("/") + 1)
      return alternatives.some((alternative) =>
        alternative.regex.test(alternative.anyDepth ? name : relativePath)
      )
    },

    mayContain(relativeFolder) {
      const names = relativeFolder.split("/")
      return alternatives.some((alternative) => {
        if (alternative.anyDepth) return true

        for (const [index, name] of names.entries()) {
          const segment = alternative.segments[index]
          if (segment === undefined) return false
          if (segment === "**") return true
          if (!segmentMatches(segment, name)) return false
        }
        // The folder matched as far as it goes: the pattern must still name what is inside.
        return alternative.segments.length > names.length
      })
    },

    namesHidden: segments.some((segment) => segment.startsWith(".")),
    namesNodeModules: segments.some((segment) => segment.includes("node_modules")),
  }
}

function compileAlternative(pattern: string): Alternative {
  let relative = pattern
  while (relative.startsWith("./")) relative = relative.slice(2)

  // A leading `/` anchors the pattern where the search starts, as in `.gitignore`.
  const anchored = relative.startsWith("/")
  if (anchored) relative = relative.replace(/^\/+/, "")
  if (!relative) throw new PatternError("it names no file")

  const anyDepth = !anchored && !relative.includes("/")
  const segments = relative.split("/")
  return {
    anyDepth,
    regex: compilePattern(anyDepth ? segmentSource(relative) : pathPatternSource(relative)),
    segments,
  }
}
