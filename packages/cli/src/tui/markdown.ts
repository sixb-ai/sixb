/**
 * The markdown of an answer still being written, as it can be drawn without moving: what is on
 * screen only ever grows. Raw markdown that the next characters would turn into something else is
 * closed early or held back:
 *
 * - an emphasis or code span the last line opened is closed, so `**sum` is drawn bold now rather
 *   than as `**sum` that loses its two stars when `**` arrives;
 * - a link waits for its label, then shows as that label until its address is complete: a
 *   terminal without clickable links draws the address after it, which would grow mid-line;
 * - a last line holding only a block's marker (`##`, `-`, `2`, `>`) waits for its text;
 * - a table waits until it is complete: its columns are sized to its widest cell, so every row
 *   could resize the ones above it;
 * - so does a quote, whose text OpenTUI draws raw until it is highlighted.
 *
 * Inside an open code fence everything is code, drawn as it arrives.
 */
export function steadyMarkdown(text: string): string {
  // A line that just ended may still be followed by more of its block, a table's next row.
  const lines = text.trimStart().replace(/\n$/, "").split("\n")
  const last = lines.at(-1) ?? ""
  const fences = lines.filter((line) => /^\s*(?:```|~~~)/.test(line)).length
  if (fences % 2 === 1) {
    // `` may be the fence that closes it, which is no line of the code.
    if (/^\s*(?:`{1,2}|~{1,2})$/.test(last)) lines.pop()
    return lines.join("\n")
  }

  if (BLOCK_MARKER_ONLY.test(last)) lines.pop()
  else lines[lines.length - 1] = closeInline(holdLink(last))

  // The last block, the lines after the last blank one, when it is a table or a quote.
  let start = lines.length
  while (start > 0 && lines[start - 1]?.trim()) start -= 1
  const block = lines.slice(start).map((line) => line.trimStart()[0])
  if (block.every((first) => first === "|") || block.every((first) => first === ">")) {
    lines.splice(start)
  }
  return lines.join("\n").trimEnd()
}

/** A line that is only the start of a block: a heading's, a list item's or a quote's marker. */
const BLOCK_MARKER_ONLY = /^\s*(?:#{1,6}|[-*+]|\d{1,9}[.)]?|>|`{1,2}|~{1,2}|[-*_=]{2})\s*$/

/** `line` without a link whose label is not finished, and with one whose address is not as its label. */
function holdLink(line: string): string {
  const outsideCode = (at: number) => (line.slice(0, at).split("`").length - 1) % 2 === 0
  const label = /!?\[[^\]]*\]?$/.exec(line)
  if (label && outsideCode(label.index)) return line.slice(0, label.index).trimEnd()
  const address = /!?\[([^\]]*)\]\([^)\s]*$/.exec(line)
  if (address && outsideCode(address.index)) return `${line.slice(0, address.index)}${address[1]}`
  return line
}

/** Emphasis and code markers, longest first: `**` is one marker, not two `*`. */
const MARKERS = ["`", "**", "~~", "*"] as const

/**
 * `line` with each emphasis or code span it leaves open closed, the innermost first; an opener
 * with nothing after it yet is dropped instead.
 */
function closeInline(line: string): string {
  const open: { readonly marker: string; readonly at: number }[] = []
  // A list item's `* ` is its bullet, not emphasis.
  let at = /^\s*\*\s/.test(line) ? line.indexOf("*") + 1 : 0
  while (at < line.length) {
    if (line[at] === "\\") {
      at += 2
      continue
    }
    const inCode = open.at(-1)?.marker === "`"
    const marker = MARKERS.find((each) => line.startsWith(each, at) && (!inCode || each === "`"))
    if (!marker) {
      at += 1
      continue
    }
    const next = line[at + marker.length]
    if (open.at(-1)?.marker === marker) open.pop()
    // An opener is followed by text, as markdown's is: `a * b` multiplies. One at the end of the
    // line may still be.
    else if (marker === "`" || next === undefined || /\S/.test(next)) open.push({ marker, at })
    at += marker.length
  }

  let closed = line
  for (const { marker, at: opened } of open.reverse()) {
    closed = closed.slice(opened + marker.length).trim()
      ? `${closed.trimEnd()}${marker}`
      : closed.slice(0, opened).trimEnd()
  }
  return closed
}
