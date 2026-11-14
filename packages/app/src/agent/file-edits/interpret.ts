import { type AgentMessages, en } from "../i18n/en"
import type { NormalizedTool } from "../parts"

/** One line of the unified diff `edit` returns. */
export interface DiffLine {
  readonly kind: "hunk" | "added" | "removed" | "context" | "note"
  readonly text: string
}

export interface FileEditDescription {
  /** The path the call named, or empty until it streams in. */
  readonly path: string
  readonly title: string
  readonly runningTitle: string
  readonly failedTitle: string
  /** `+3 −1` for an edit, the line count for a write, once it has a result. */
  readonly detail?: string
  readonly added: number
  readonly removed: number
  /** The edit's diff, or the written file's contents as added lines. */
  readonly lines: readonly DiffLine[]
}

export function describeEdit(
  tool: Pick<NormalizedTool, "input" | "output">,
  messages: AgentMessages = en
): FileEditDescription {
  const m = messages.edit
  const path = stringField(tool.input, "path") ?? stringField(tool.output, "path") ?? ""
  const name = fileName(path)
  const diff = stringField(tool.output, "diff")
  const lines = diff === undefined ? [] : parseDiff(diff)

  // The diff is cut on a large edit, so the edit counts its lines; an output stored before it
  // did carries only the diff.
  const added =
    numberField(tool.output, "added") ?? lines.filter((line) => line.kind === "added").length
  const removed =
    numberField(tool.output, "removed") ?? lines.filter((line) => line.kind === "removed").length

  return {
    path,
    title: m.title(name),
    runningTitle: m.running(name),
    failedTitle: m.failed(name),
    ...(diff === undefined ? {} : { detail: `+${added} −${removed}` }),
    added,
    removed,
    lines,
  }
}

export function describeWrite(
  tool: Pick<NormalizedTool, "input" | "output">,
  messages: AgentMessages = en
): FileEditDescription {
  const m = messages.write
  const path = stringField(tool.input, "path") ?? stringField(tool.output, "path") ?? ""
  const name = fileName(path)
  const content = stringField(tool.input, "content")
  const created = booleanField(tool.output, "created")
  const lineCount = numberField(tool.output, "lines")
  const lines: DiffLine[] =
    content === undefined
      ? []
      : contentLines(content).map((text) => ({ kind: "added" as const, text }))
  return {
    path,
    title: created === false ? m.replaced(name) : m.created(name),
    runningTitle: m.running(name),
    failedTitle: m.failed(name),
    ...(lineCount === undefined ? {} : { detail: m.lines(lineCount) }),
    added: lines.length,
    removed: 0,
    lines,
  }
}

/** A unified diff's lines by kind; `… 3 more hunks` and anything unexpected are notes. */
export function parseDiff(diff: string): DiffLine[] {
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n")
  return lines.map((line): DiffLine => {
    if (line.startsWith("@@")) return { kind: "hunk", text: line }
    if (line.startsWith("+")) return { kind: "added", text: line.slice(1) }
    if (line.startsWith("-")) return { kind: "removed", text: line.slice(1) }
    if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) }
    return { kind: "note", text: line }
  })
}

const MAX_CONTENT_LINES = 400

function contentLines(content: string): string[] {
  if (content === "") return []
  const lines = (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
  return lines.length > MAX_CONTENT_LINES ? lines.slice(0, MAX_CONTENT_LINES) : lines
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? ""
}

function stringField(value: unknown, key: string): string | undefined {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === "string" ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === "number" && Number.isInteger(field) ? field : undefined
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === "boolean" ? field : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
