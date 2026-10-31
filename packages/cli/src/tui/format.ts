import type { Part } from "./parts"

type ToolPart = Extract<Part, { readonly kind: "tool" }>

/** A tool call as one line: what it did, then what it acted on. */
export interface ToolLine {
  readonly verb: string
  readonly detail: string
  /** A few lines of what came back, when they say something the line does not. */
  readonly preview?: readonly string[]
  /** A short outcome beside the line: `exit 1`, `3 lines`. */
  readonly note?: string
  readonly failed?: boolean
  /** A call the API held for the person's approval: neither done nor failed. */
  readonly held?: boolean
  /** A shell command, shown whole as the call's panel. */
  readonly command?: string
}

const PREVIEW_LINES = 4

export function toolLine(part: ToolPart): ToolLine {
  const input = record(part.input) ?? partialInput(part.inputText)
  const output = record(part.output)
  const failed = part.state === "error"
  const error = failed ? { note: firstLine(part.error ?? "failed"), failed } : {}

  switch (part.name) {
    case "bash": {
      const command = text(input?.command)
      const exitCode = typeof output?.exitCode === "number" ? output.exitCode : undefined
      const stdout = text(output?.stdout)
      const stderr = text(output?.stderr)
      const shown = exitCode !== undefined && exitCode !== 0 && stderr ? stderr : stdout || stderr
      // `sixb` answers a call it held for approval with its status, and a nonzero exit.
      const held = stdout.includes('"status":"awaiting_approval"')
      return {
        verb: "bash",
        command: command.trim(),
        detail: firstLine(command) + (command.includes("\n") ? " …" : ""),
        ...(shown && !held ? { preview: lines(shown) } : {}),
        ...(held
          ? { note: "held for your approval", held }
          : exitCode !== undefined && exitCode !== 0
            ? { note: `exit ${exitCode}`, failed: true }
            : {}),
        ...error,
      }
    }
    case "read": {
      const lineCount = typeof output?.endLine === "number" && typeof output.startLine === "number"
      return {
        verb: "read",
        detail: text(input?.path),
        ...(lineCount
          ? { note: `lines ${output?.startLine}–${output?.endLine}${output?.truncated ? "+" : ""}` }
          : {}),
        ...error,
      }
    }
    case "view_file":
      return { verb: "view", detail: text(input?.path), ...error }
    case "publish_artifact":
    case "publish_artifact_version":
      return {
        verb: "publish",
        detail: text(input?.title) || text(input?.path) || text(input?.artifactId),
        ...(output?.artifactId ? { note: `artifact:${text(output.artifactId)}` } : {}),
        ...error,
      }
    case "spawn_agent":
      return {
        verb: "agent",
        detail: [text(input?.key), firstLine(text(input?.task))].filter(Boolean).join("  "),
        ...error,
      }
    case "wait_agent": {
      const runIds = Array.isArray(input?.runIds) ? input.runIds.length : 0
      return {
        verb: "wait",
        detail: runIds === 1 ? "for its agent" : `for ${runIds || "its"} agents`,
        ...error,
      }
    }
    case "message_agent":
      return {
        verb: "message",
        detail: [text(input?.key), firstLine(text(input?.text))].filter(Boolean).join("  "),
        ...error,
      }
    case "ask_parent":
      return {
        verb: "ask",
        detail: firstLine(text(input?.question) || text(input?.text)),
        ...error,
      }
    default:
      return {
        verb: part.name,
        detail: compact(part.input ?? part.inputText),
        ...(part.state === "done" && part.output !== undefined
          ? { preview: lines(compact(part.output)) }
          : {}),
        ...error,
      }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The input so far, while the model still writes it, read where it already parses. */
function partialInput(inputText: string | undefined): Record<string, unknown> | undefined {
  if (!inputText) return undefined
  try {
    return record(JSON.parse(inputText))
  } catch {
    const command = /"(?:command|path|task|key)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(inputText)
    return command ? { command: command[1], path: command[1], task: command[1] } : undefined
  }
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value)
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? ""
}

function lines(value: string): string[] {
  const all = value.replace(/\s+$/, "").split("\n")
  return all.length > PREVIEW_LINES
    ? [...all.slice(0, PREVIEW_LINES), `… ${plural(all.length - PREVIEW_LINES, "more line")}`]
    : all
}

/** A value on one line, for a tool with no line of its own. */
function compact(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return firstLine(value)
  const json = JSON.stringify(value)
  return json && json.length > 160 ? `${json.slice(0, 157)}…` : (json ?? "")
}

/** `1m 04s`, `12.4s`, `820ms`. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 59_950) return `${(ms / 1_000).toFixed(1)}s`
  const total = Math.round(ms / 1_000)
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
}

/** A path with the home directory as `~`, and its middle elided past `max` characters. */
export function shortPath(path: string, home: string, max = 48): string {
  const homed = path.startsWith(home) ? `~${path.slice(home.length)}` : path
  if (homed.length <= max) return homed
  const parts = homed.split("/")
  const last = parts.at(-1) ?? ""
  const head = parts.slice(0, 2).join("/")
  const elided = `${head}/…/${last}`
  if (elided.length <= max) return elided
  return last.length + 2 <= max ? `…/${last}` : ""
}

/** `1 more line`, `3 more lines`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/**
 * A path as the person reads it: relative to the folder the agent works in, and the run's own
 * files, kept outside it, as `run/…`.
 */
export function friendlyPath(text: string, folder?: string): string {
  let shown = text.replace(
    /\/(?:private\/)?(?:var|tmp)\/[^\s"']*?\/sixb-agent\/[^/\s"']+\//g,
    "run/"
  )
  if (folder) {
    const prefixes = [folder, folder.replace(/^\/private/, "")].map((prefix) => `${prefix}/`)
    for (const prefix of prefixes) shown = shown.split(prefix).join("")
  }
  return shown
}
