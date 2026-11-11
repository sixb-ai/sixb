/**
 * The text half of `edit`: find `old` in a file, replace it, and describe the change as a unified
 * diff, or say where to look when it does not match. No sandbox here, so it is tested on strings.
 */

const DIFF_CONTEXT_LINES = 2
const MAX_DIFF_CHARACTERS = 4_000
const MAX_LISTED_MATCHES = 10

export type EditTextResult =
  | {
      readonly ok: true
      readonly text: string
      readonly replaced: number
      readonly diff: string
      /** Lines the change adds and removes, all of them: the diff may be cut. */
      readonly added: number
      readonly removed: number
    }
  | { readonly ok: false; readonly reason: string }

export function editText(
  text: string,
  input: { readonly old: string; readonly new: string; readonly all: boolean }
): EditTextResult {
  let { old, new: replacement } = input
  let starts = occurrences(text, old)
  // A model writes "\n" for a file that ends its lines with "\r\n": match it the file's way.
  if (starts.length === 0 && text.includes("\r\n") && !old.includes("\r")) {
    const crlf = (value: string) => value.replace(/\n/g, "\r\n")
    const found = occurrences(text, crlf(old))
    if (found.length > 0) {
      old = crlf(old)
      replacement = crlf(replacement)
      starts = found
    }
  }

  if (starts.length === 0) return { ok: false, reason: missReason(text, input.old) }
  if (starts.length > 1 && !input.all) {
    const lineOf = lineIndex(text)
    const lines = starts.slice(0, MAX_LISTED_MATCHES).map((start) => lineOf(start))
    const more = starts.length > MAX_LISTED_MATCHES ? ", …" : ""
    return {
      ok: false,
      reason: `old_string matches ${starts.length} times (lines ${lines.join(", ")}${more}). Add surrounding lines to make it unique, or pass replace_all: true.`,
    }
  }

  let result = ""
  let cursor = 0
  for (const start of starts) {
    result += text.slice(cursor, start) + replacement
    cursor = start + old.length
  }
  result += text.slice(cursor)
  return {
    ok: true,
    text: result,
    replaced: starts.length,
    ...unifiedDiff(text, result, starts, old.length, replacement.length),
  }
}

/** Where `needle` starts in `text`, without overlaps, left to right. */
function occurrences(text: string, needle: string): number[] {
  const starts: number[] = []
  for (let index = text.indexOf(needle); index !== -1; ) {
    starts.push(index)
    index = text.indexOf(needle, index + needle.length)
  }
  return starts
}

/** A lookup of the 1-based line an offset of `text` falls on, by binary search. */
function lineIndex(text: string): (offset: number) => number {
  const newlines: number[] = []
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines.push(index)
  }
  return (offset) => {
    let low = 0
    let high = newlines.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((newlines[middle] ?? 0) < offset) low = middle + 1
      else high = middle
    }
    return low + 1
  }
}

/**
 * Why nothing matched, with where to look: the same lines with other spacing, or the line the
 * first line of `old` is on. Most misses are indentation or a stale copy of the file.
 */
function missReason(text: string, old: string): string {
  const fileLines = text.split(/\r?\n/)
  const wanted = old.split(/\r?\n/)
  while (wanted.length > 1 && wanted.at(-1)?.trim() === "") wanted.pop()
  const squash = (line: string) => line.trim().replace(/\s+/g, " ")
  const target = wanted.map(squash)

  for (let start = 0; start + target.length <= fileLines.length; start += 1) {
    if (target.every((line, offset) => squash(fileLines[start + offset] ?? "") === line)) {
      const range =
        target.length === 1 ? `line ${start + 1}` : `lines ${start + 1}-${start + target.length}`
      return `old_string matches nothing exactly. The same text with other whitespace is at ${range}: copy it as the file has it.`
    }
  }

  const first = target.find((line) => line !== "")
  if (first) {
    const at = fileLines.findIndex((line) => squash(line) === first)
    if (at !== -1) {
      return `old_string matches nothing. Its first line is at line ${at + 1}, but what follows differs: read the file there again.`
    }
  }
  return "old_string matches nothing in the file. Read the file again and copy the text exactly."
}

interface ChangedRange {
  /** 0-based, end exclusive, in the old and the new text's lines. */
  readonly oldStart: number
  readonly oldEnd: number
  readonly newStart: number
  readonly newEnd: number
}

/** A text's lines, its final newline ending the last rather than starting an empty one. */
function textLines(text: string): readonly string[] {
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n")
}

/**
 * The replacements as unified-diff hunks, nearby ones merged, cut past a few thousand characters,
 * and the lines they add and remove, counted before the cut.
 */
function unifiedDiff(
  before: string,
  after: string,
  starts: readonly number[],
  oldLength: number,
  newLength: number
): { readonly diff: string; readonly added: number; readonly removed: number } {
  // A file's final newline ends its last line: it starts no empty one.
  const oldLines = textLines(before)
  const newLines = textLines(after)
  const oldLineOf = lineIndex(before)
  const newLineOf = lineIndex(after)
  const ranges: ChangedRange[] = []
  let shift = 0
  for (const start of starts) {
    // Every line the replacement touches, then the lines both sides still share trimmed off: a
    // match ending in "\n" reaches the next line, which the new text may leave as it was.
    let oldStart = oldLineOf(start) - 1
    let oldEnd = oldLineOf(start + oldLength)
    let newStart = newLineOf(start + shift) - 1
    let newEnd = newLineOf(start + shift + newLength)
    // A match ending with the final newline reaches no line past the last.
    oldEnd = Math.min(oldEnd, oldLines.length)
    newEnd = Math.min(newEnd, newLines.length)
    while (
      oldEnd > oldStart &&
      newEnd > newStart &&
      oldLines[oldEnd - 1] === newLines[newEnd - 1]
    ) {
      oldEnd -= 1
      newEnd -= 1
    }
    while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) {
      oldStart += 1
      newStart += 1
    }

    // Two matches on one line change it once: their ranges merge, so the line shows once.
    const previous = ranges.at(-1)
    if (previous && (oldStart < previous.oldEnd || newStart < previous.newEnd)) {
      ranges[ranges.length - 1] = {
        oldStart: Math.min(previous.oldStart, oldStart),
        oldEnd: Math.max(previous.oldEnd, oldEnd),
        newStart: Math.min(previous.newStart, newStart),
        newEnd: Math.max(previous.newEnd, newEnd),
      }
    } else {
      ranges.push({ oldStart, oldEnd, newStart, newEnd })
    }
    shift += newLength - oldLength
  }

  // Counted before the diff is cut, so they hold the whole change.
  let added = 0
  let removed = 0
  for (const range of ranges) {
    removed += range.oldEnd - range.oldStart
    added += range.newEnd - range.newStart
  }

  const hunks: ChangedRange[][] = []
  for (const range of ranges) {
    const last = hunks.at(-1)
    const previous = last?.at(-1)
    if (last && previous && range.oldStart - previous.oldEnd <= DIFF_CONTEXT_LINES * 2) {
      last.push(range)
    } else {
      hunks.push([range])
    }
  }

  let diff = ""
  for (const [index, group] of hunks.entries()) {
    const first = group[0]!
    const last = group.at(-1)!
    const oldFrom = Math.max(0, first.oldStart - DIFF_CONTEXT_LINES)
    const oldTo = Math.min(oldLines.length, last.oldEnd + DIFF_CONTEXT_LINES)
    const newFrom = first.newStart - (first.oldStart - oldFrom)
    const newTo = last.newEnd + (oldTo - last.oldEnd)

    const body: string[] = []
    let oldCursor = oldFrom
    for (const range of group) {
      for (; oldCursor < range.oldStart; oldCursor += 1) body.push(` ${oldLines[oldCursor]}`)
      for (let line = range.oldStart; line < range.oldEnd; line += 1) {
        body.push(`-${oldLines[line]}`)
      }
      for (let line = range.newStart; line < range.newEnd; line += 1) {
        body.push(`+${newLines[line]}`)
      }
      oldCursor = range.oldEnd
    }
    for (; oldCursor < oldTo; oldCursor += 1) body.push(` ${oldLines[oldCursor]}`)

    const hunk = `@@ -${oldFrom + 1},${oldTo - oldFrom} +${newFrom + 1},${newTo - newFrom} @@\n${body.join("\n")}\n`
    if (diff.length + hunk.length > MAX_DIFF_CHARACTERS) {
      const left = hunks.length - index
      return { diff: `${diff}… ${left} more ${left === 1 ? "hunk" : "hunks"}\n`, added, removed }
    }
    diff += hunk
  }
  return { diff, added, removed }
}
