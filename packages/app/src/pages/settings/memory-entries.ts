/**
 * The entries of a memory note, as the Memory page lists and edits them: each top-level bullet is
 * one entry, `- What the agent learned (added YYYY-MM-DD)`. Every other line, such as a heading or
 * a paragraph, is kept as it is when an entry changes, so the file round-trips untouched.
 */

/** One entry: the line it is on, its text, and the day it was added when it says. */
export interface MemoryEntry {
  readonly line: number
  readonly text: string
  readonly added?: string
}

/** What a note holds, in order: entries, the headings between them, and any other text. */
export type MemoryBlock =
  | { readonly kind: "entry"; readonly entry: MemoryEntry }
  | { readonly kind: "heading"; readonly line: number; readonly text: string }
  | { readonly kind: "text"; readonly line: number; readonly text: string }

const BULLET = /^[-*+][ \t]+(.*)$/
const HEADING = /^#{1,6}[ \t]+(.*)$/
const ADDED_AT_END = /\s*\(added (\d{4}-\d{2}-\d{2})\)\s*$/

/** The note's blocks, leaving out its opening `# Title`, which the page shows itself. */
export function memoryBlocks(contents: string): MemoryBlock[] {
  const lines = contents.split("\n")
  const title = lines.findIndex((line) => line.trim() !== "")
  const blocks: MemoryBlock[] = []
  for (const [line, raw] of lines.entries()) {
    const text = raw.trimEnd()
    if (text.trim() === "") continue
    const heading = text.match(HEADING)
    if (heading) {
      if (line === title && text.startsWith("# ")) continue
      blocks.push({ kind: "heading", line, text: heading[1] ?? "" })
      continue
    }
    const bullet = text.match(BULLET)
    if (bullet) {
      blocks.push({ kind: "entry", entry: parseEntry(line, bullet[1] ?? "") })
      continue
    }
    blocks.push({ kind: "text", line, text: text.trim() })
  }
  return blocks
}

/** Every entry of the note, in order. */
export function memoryEntries(contents: string): MemoryEntry[] {
  return memoryBlocks(contents).flatMap((block) => (block.kind === "entry" ? [block.entry] : []))
}

/** The note with one entry's text replaced, keeping the day it was added. */
export function replaceMemoryEntry(contents: string, entry: MemoryEntry, text: string): string {
  return replaceLine(contents, entry.line, entryLine(text, entry.added))
}

/** The note without one entry. */
export function removeMemoryEntry(contents: string, entry: MemoryEntry): string {
  const lines = contents.split("\n")
  lines.splice(entry.line, 1)
  return lines.join("\n")
}

/** The note with a new entry right after line `after`, such as a section's last entry or heading. */
export function insertMemoryEntry(
  contents: string,
  after: number,
  text: string,
  today: string
): string {
  const lines = contents.split("\n")
  lines.splice(after + 1, 0, entryLine(text, today))
  return lines.join("\n")
}

/** An entry as the agent writes it. */
export function entryLine(text: string, added?: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim()
  return added ? `- ${oneLine} (added ${added})` : `- ${oneLine}`
}

/** Today in the reader's time zone, as entries date themselves. */
export function memoryToday(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function parseEntry(line: number, body: string): MemoryEntry {
  const added = body.match(ADDED_AT_END)
  return added?.[1]
    ? { line, text: body.slice(0, added.index).trim(), added: added[1] }
    : { line, text: body.trim() }
}

function replaceLine(contents: string, line: number, text: string): string {
  const lines = contents.split("\n")
  lines[line] = text
  return lines.join("\n")
}
