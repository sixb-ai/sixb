import { SEARCH_LIMITS, SearchError } from "./request"

/** Where a line first matched `grep`'s pattern, in UTF-16 units. */
export interface LineMatch {
  readonly index: number
  readonly length: number
}

export interface TextMatcher {
  /**
   * Where a line first matches, over its first {@link SEARCH_LIMITS.matchCharacters} characters.
   */
  line(line: string): LineMatch | undefined
  /**
   * Whether any line of a file may match: false only when none does, so a file that cannot match
   * is never split into lines. It may say true of a file with no matching line.
   */
  mayMatch(text: string): boolean
}

/**
 * `grep`'s pattern, matched line by line. Case is smart: ignored when the pattern has no uppercase
 * letter. Literal text is a plain substring search, which no line can slow down.
 */
export function textMatcher(pattern: string, literal: boolean): TextMatcher {
  return literal ? literalMatcher(pattern) : regexMatcher(pattern)
}

function literalMatcher(pattern: string): TextMatcher {
  const ignoreCase = !/\p{Lu}/u.test(pattern)
  const needle = ignoreCase ? pattern.toLowerCase() : pattern

  return {
    line(line) {
      const matched = linePrefix(line, SEARCH_LIMITS.matchCharacters)
      const index = (ignoreCase ? matched.toLowerCase() : matched).indexOf(needle)

      // Lowercasing lengthens a few characters (İ): the index is then near the match, not on it.
      return index < 0 ? undefined : { index: Math.min(index, line.length), length: needle.length }
    },

    // A line's text is part of the file's. Lowercasing is the same character by character, but
    // for Σ, which reads what follows it: only where a line is cut at 4,000 characters does that
    // differ from the file's text, and a file with such a line is searched line by line.
    mayMatch(text) {
      if (!ignoreCase) return text.includes(needle)
      if (hasLineOver(text, SEARCH_LIMITS.matchCharacters)) return true

      return text.toLowerCase().includes(needle)
    },
  }
}

function regexMatcher(pattern: string): TextMatcher {
  const regex = lineRegex(pattern)
  const whole = wholeTextRegex(pattern, regex)

  return {
    line(line) {
      const found = regex.exec(linePrefix(line, SEARCH_LIMITS.matchCharacters))
      return found ? { index: found.index, length: found[0].length } : undefined
    },

    mayMatch(text) {
      if (!whole || !linesAreWhole(text)) return true
      return whole.test(text)
    },
  }
}

/**
 * Unicode mode first, so `\p{…}` works; without it when that refuses what plain mode accepts.
 * Case is ignored when the pattern writes no uppercase letter and no property escape: `\p{Lu}`
 * ignoring case would match every cased letter.
 */
function lineRegex(pattern: string): RegExp {
  const written = pattern.replace(/\\(?:[pP]\{[^}]*\}|.)/g, "")
  const flags = /\p{Lu}/u.test(written) || /\\[pP]\{/.test(pattern) ? "" : "i"

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

/**
 * The line regex with `m`, to test a whole file at once; nothing for a pattern written with a
 * lookaround or a modifier group, or that can match a line break. The test stands in for the lines
 * only on a file whose lines are whole ({@link linesAreWhole}).
 *
 * Why a line's match is then a match in the whole text: the line is a stretch of it, and the
 * same characters match the same way. The pattern consumes no line break, so a match never
 * leaves the line: what can still differ is what its assertions read.
 *
 * - `^` and `$`: with `m`, they hold where a line starts or ends, `\n` and `\r\n` alike. With no
 *   lone `\r` and no U+2028 or U+2029 in the file, those are exactly a line's edges: in the line
 *   and in the whole text, they hold at the same places.
 * - `\b` and `\B`: past a line's edge, the whole text holds `\n` or `\r`, which is no word
 *   character, as nothing is: they read the same at a line's edges.
 * - Backreferences repeat what their group matched in the line.
 * - A lookaround could say no where an assertion says yes, and is rare in a search: a pattern
 *   with one is searched line by line, so nothing above rests on how one reads. A modifier group
 *   changes the flags themselves: `(?-m:^)` turns `m` back off.
 *
 * A match in the whole text that no line holds, across lines, is never reported: it only costs a
 * file split into lines.
 *
 * Why the test stays fast: a line bounds what each try can read, and with it how far a regex
 * backtracks. A pattern that can match a line break backtracks over the whole file instead —
 * `[^x]*y` takes seconds on 100 KB — which is the other reason it is searched line by line.
 */
function wholeTextRegex(pattern: string, line: RegExp): RegExp | undefined {
  if (!readsOneLine(pattern)) return undefined
  return new RegExp(line.source, `${line.flags}m`)
}

/**
 * Whether the line breaks `m` sees are the lines `grep` splits, each matched whole: no line is
 * cut at {@link SEARCH_LIMITS.matchCharacters}, and no lone `\r`, U+2028 or U+2029, which end a
 * line for `^` and `$` but stay inside one for {@link lines}.
 */
function linesAreWhole(text: string): boolean {
  return !hasLineOver(text, SEARCH_LIMITS.matchCharacters) && !hasLoneBreak(text)
}

/** A `\r` not followed by `\n`, U+2028 or U+2029. Searched for as text, faster than a regex. */
function hasLoneBreak(text: string): boolean {
  if (text.includes("\u2028") || text.includes("\u2029")) return true

  for (let index = text.indexOf("\r"); index >= 0; index = text.indexOf("\r", index + 1)) {
    if (text.charCodeAt(index + 1) !== LINE_FEED) return true
  }

  return false
}

const LINE_FEED = 0x0a

/** Escapes that never match a line break, outside a class and inside one. */
const ESCAPES = new Set(["b", "B", "d", "w", "S", "k"])
const CLASS_ESCAPES = new Set(["d", "w", "S"])

/**
 * Whether a pattern, as written, has no lookaround, no modifier group, and cannot match `\n`,
 * `\r`, U+2028 or U+2029. What it cannot rule out says no:
 *
 * - `(?=`, `(?!`, `(?<=`, `(?<!`, and `(?i:`, `(?m:`, `(?s:`, `(?-…:` outside a class.
 * - `.` never matches a line break, without the `s` flag, nor do `\d`, `\w` and `\S`.
 * - A negated class does, unless it names them: `[^…]` says no.
 * - `\s`, `\D`, `\W`, `\n`, `\r`, `\t`, `\v`, `\f`, `\0`, `\x…`, `\u…`, `\c…`, `\p{…}` and digit
 *   escapes (an octal `\12` is `\n` without the `u` flag) all may, alone or as a range's end.
 * - So may a control character or a line separator written as itself, escaped or not, and a
 *   range that spans one.
 * - `\b` and `\B` are assertions, and `\k<name>` repeats a group's text; in a class, `\b` is a
 *   backspace, a control character.
 */
function readsOneLine(pattern: string): boolean {
  let inClass = false
  /** The class's last character, a range's start. */
  let previous: number | undefined

  for (let index = 0; index < pattern.length; index += 1) {
    let code = pattern.charCodeAt(index)
    if (isLineBreakOrControl(code)) return false

    if (code === BACKSLASH) {
      index += 1
      const escaped = pattern[index] ?? ""
      if (/[A-Za-z0-9]/.test(escaped)) {
        if (!(inClass ? CLASS_ESCAPES : ESCAPES).has(escaped)) return false
        previous = undefined
        continue
      }

      // An escaped symbol is the symbol itself.
      code = pattern.charCodeAt(index)
      if (isLineBreakOrControl(code)) return false
    } else if (!inClass && code === OPEN_PAREN) {
      if (LOOKAROUND_OR_MODIFIER.test(pattern.slice(index, index + 4))) return false
    } else if (!inClass && code === OPEN_BRACKET) {
      if (pattern[index + 1] === "^") return false
      inClass = true
      previous = undefined
      continue
    } else if (inClass && code === CLOSE_BRACKET) {
      inClass = false
      continue
    } else if (inClass && code === DASH && previous !== undefined && index + 1 < pattern.length) {
      const end =
        pattern[index + 1] === "\\" ? pattern.charCodeAt(index + 2) : pattern.charCodeAt(index + 1)
      if (previous <= 0x2029 && end >= 0x2028) return false
    }

    previous = inClass ? code : undefined
  }

  return true
}

/** At a `(`: a lookaround, or a group that changes the `i`, `m` or `s` flag. */
const LOOKAROUND_OR_MODIFIER = /^\(\?(?:[=!]|<[=!]|[ims-])/

const OPEN_PAREN = 0x28
const BACKSLASH = 0x5c
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const DASH = 0x2d

function isLineBreakOrControl(code: number): boolean {
  return code < 0x20 || code === 0x2028 || code === 0x2029
}

/** Whether a line of the text, its `\r` included, is longer than `length` UTF-16 units. */
function hasLineOver(text: string, length: number): boolean {
  if (text.length <= length) return false

  for (let start = 0; start <= text.length; ) {
    const newline = text.indexOf("\n", start)
    const end = newline < 0 ? text.length : newline
    if (end - start > length) return true
    start = end + 1
  }

  return false
}

/** A file's lines, without their `\n` or `\r\n`. */
export function lines(text: string): string[] {
  const split = text.split("\n")
  if (split.at(-1) === "") split.pop()
  return split.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
}

/**
 * A line as `grep` shows it: whole when it fits, else cut to {@link SEARCH_LIMITS.lineCharacters}
 * characters around its first match, so a match far into a minified line is still seen. A cut
 * never splits a character written as two units.
 */
export function cutLine(line: string, match: LineMatch): string {
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
