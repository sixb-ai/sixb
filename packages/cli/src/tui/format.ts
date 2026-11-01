import type { ApprovalOutcome, Part } from "./parts"

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

const NO_OUTCOMES: ReadonlyMap<string, ApprovalOutcome> = new Map()

/** `outcomes` says how the held calls ended, by approval id: a decided call is no longer held. */
export function toolLine(
  part: ToolPart,
  outcomes: ReadonlyMap<string, ApprovalOutcome> = NO_OUTCOMES
): ToolLine {
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
      const heldIds = heldApprovalIds(stdout)
      const decided = heldIds.flatMap((id) => outcomes.get(id) ?? [])
      const held = heldIds.length > decided.length
      return {
        verb: "bash",
        command: command.trim(),
        detail: firstLine(command) + (command.includes("\n") ? " …" : ""),
        ...(shown && heldIds.length === 0 ? { preview: lines(shown) } : {}),
        ...(held
          ? { note: "held for your approval", held }
          : heldIds.length > 0
            ? decidedLine(decided)
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

/**
 * The approvals a `bash` output says it waits for. `sixb` prints the API's answer to a call it held
 * as one JSON line naming the approval, but the output is the model's to shape: as in the web
 * chat, only a line that names a record counts, wherever it sits.
 */
function heldApprovalIds(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) return []

    const parsed = record(parseJson(trimmed))
    if (parsed?.status !== "awaiting_approval") return []

    const approval = record(parsed.approval)
    return typeof approval?.id === "string" && approval.id ? [approval.id] : []
  })
}

/** How decided calls ended, as the web chat's approval card names it. */
function decidedLine(outcomes: readonly ApprovalOutcome[]): Pick<ToolLine, "note" | "failed"> {
  const ended = outcomes.map(outcomeNote)
  const failed = ended.some((entry) => entry.failed)
  return {
    note: [...new Set(ended.map((entry) => entry.note))].join(", "),
    ...(failed ? { failed } : {}),
  }
}

function outcomeNote(outcome: ApprovalOutcome): { readonly note: string; readonly failed?: true } {
  switch (outcome.status) {
    case "approved": {
      const ran = outcome.outcome
      if (ran?.kind === "error" && ran.error.code === "agent.approval_authority_lost") {
        return { note: "approved, but it didn't run", failed: true }
      }
      if (ran?.kind === "error" || (ran?.kind === "action-run" && ran.status === "failed")) {
        return { note: "approved, but it failed", failed: true }
      }
      return { note: "approved" }
    }
    case "denied":
      return { note: "denied" }
    case "superseded":
      return { note: "set aside" }
    case "cancelled":
      return { note: "stopped" }
    case "expired":
      return { note: "expired" }
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
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

/** Why a run failed, in a line; a conversation too long for its model says how to go on. */
export function runFailureText(error: { readonly code: string; readonly message: string }): string {
  if (error.code === "agent.context_limit_exceeded") {
    return "This conversation is too long for the model: /new starts another, /model picks a larger one."
  }
  return error.message
}

/** A part of what a conversation uses, as the API names it. */
export type ContextPartName =
  | "system"
  | "instructions"
  | "memory"
  | "skills"
  | "ontology"
  | "tools"
  | "summary"
  | "messages"
  | "toolResults"
  | "files"

/** What the status line and `/context` need of a conversation's context against its limits. */
export interface ContextUse {
  /** The model the limits are this one's. */
  readonly model?: { readonly provider: string; readonly modelId: string }
  readonly windowTokens?: number
  readonly limitTokens: number
  readonly usedTokens?: number
  readonly parts?: readonly { readonly part: ContextPartName; readonly tokens: number }[]
  readonly lastCall?: { readonly inputTokens: number; readonly cacheReadInputTokens?: number }
  readonly lastCompaction?: {
    readonly createdAt: string
    readonly estimatedInputTokensBefore: number
    readonly estimatedInputTokensAfter: number
  }
}

/** How full the context is: amber from 80% of the model's limit, red past it. */
export type ContextTone = "quiet" | "near" | "over"

function contextTone(used: number, limit: number): ContextTone {
  const share = used / limit
  return share > 1 ? "over" : share >= 0.8 ? "near" : "quiet"
}

/**
 * The context as the status line shows it, `ctx 38k/100k · 92% cached`, then shorter where room is
 * short: `ctx 38k/100k`, then `ctx 21%`. Undefined before the first answer.
 */
export function contextStatus(context: ContextUse):
  | {
      readonly text: string
      readonly short: string
      readonly shortest: string
      readonly tone: ContextTone
    }
  | undefined {
  const used = context.usedTokens
  if (used === undefined) return undefined

  const call = context.lastCall
  const cached =
    call?.cacheReadInputTokens !== undefined && call.inputTokens > 0
      ? ` · ${Math.round((call.cacheReadInputTokens / call.inputTokens) * 100)}% cached`
      : ""
  const short = `ctx ${tokenCount(used)}/${tokenCount(context.limitTokens)}`

  return {
    text: `${short}${cached}`,
    short,
    shortest: `ctx ${Math.round((used / context.limitTokens) * 100)}%`,
    tone: contextTone(used, context.limitTokens),
  }
}

/**
 * What of the context fits at the end of a status line whose items take `columns` of `room`: it
 * whole, without the cache share, its share alone, or nothing, so the line never wraps.
 */
export function fittedContextText(
  context: { readonly text: string; readonly short: string; readonly shortest: string },
  columns: number,
  room: number
): string | undefined {
  const separator = columns > 0 ? 3 : 0
  return [context.text, context.short, context.shortest].find(
    (text) => columns + separator + text.length <= room
  )
}

const CONTEXT_PART_LABELS: Readonly<Record<ContextPartName, string>> = {
  system: "Sixb instructions",
  instructions: "Project instructions",
  memory: "Memory",
  skills: "Skills",
  ontology: "Ontology",
  tools: "Tools",
  summary: "Earlier summary",
  messages: "Messages",
  toolResults: "Tool results",
  files: "Files and images",
}

/** One row of `/context`: a part, the room left, or the room kept for the answer. */
export interface ContextRow {
  readonly label: string
  readonly tokens: string
  /** Its share of what the conversation uses; none for the room left or kept. */
  readonly share?: string
  /** A part's tiles: its share of what the conversation uses, out of the row's. */
  readonly tiles: number
  readonly kind: "part" | "free" | "reserved"
}

/**
 * What `/context` shows: the use against the limit, the window as one bar of `columns.bar` tiles
 * (used, free, kept for the answer), then a row per part with its share in up to `columns.row`
 * tiles, the room left and the room kept for the answer, and when it was last condensed.
 * Undefined before the first answer.
 */
export function contextBreakdown(
  context: ContextUse,
  columns: { readonly bar: number; readonly row: number },
  now = Date.now()
):
  | {
      readonly headline: string
      readonly share: string
      readonly tone: ContextTone
      /** What a conversation near or past its limit is about to go through. */
      readonly warning?: string
      readonly bar: { readonly used: number; readonly free: number; readonly reserved: number }
      readonly rows: readonly ContextRow[]
      readonly notes: readonly string[]
    }
  | undefined {
  const used = context.usedTokens
  if (used === undefined) return undefined

  const window = context.windowTokens ?? context.limitTokens
  const reserved = Math.max(0, window - context.limitTokens)
  const free = Math.max(0, context.limitTokens - used)
  const span = Math.max(window, used + reserved)
  const scaled = (tokens: number, room: number) =>
    tokens <= 0 ? 0 : Math.max(1, Math.round((tokens / span) * room))

  // The bar's three runs fill it exactly: rounding gives its error to the room left.
  const usedTiles = Math.min(columns.bar, scaled(used, columns.bar))
  const reservedTiles = Math.min(columns.bar - usedTiles, scaled(reserved, columns.bar))
  const percent = (share: number) =>
    share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`

  const parts = (context.parts ?? []).map(
    ({ part, tokens }): ContextRow => ({
      label: CONTEXT_PART_LABELS[part],
      tokens: tokenCount(tokens),
      share: percent(used > 0 ? tokens / used : 0),
      tiles: used > 0 ? Math.max(1, Math.round((tokens / used) * columns.row)) : 0,
      kind: "part",
    })
  )
  const call = context.lastCall
  const compaction = context.lastCompaction
  const tone = contextTone(used, context.limitTokens)

  return {
    headline: `${tokenCount(used)} of ${tokenCount(context.limitTokens)} tokens`,
    share: percent(used / context.limitTokens),
    tone,
    ...(tone === "near"
      ? { warning: "Almost full: earlier messages are condensed soon." }
      : tone === "over"
        ? { warning: "Full: earlier messages are condensed next turn." }
        : {}),
    bar: {
      used: usedTiles,
      free: columns.bar - usedTiles - reservedTiles,
      reserved: reservedTiles,
    },
    rows: [
      ...parts,
      { label: "Free space", tokens: tokenCount(free), tiles: 0, kind: "free" },
      { label: "Kept for the answer", tokens: tokenCount(reserved), tiles: 0, kind: "reserved" },
    ],
    notes: [
      ...(compaction
        ? [
            `Condensed ${ago(Date.parse(compaction.createdAt), now)} · ${tokenCount(compaction.estimatedInputTokensBefore)} → ${tokenCount(compaction.estimatedInputTokensAfter)}`,
          ]
        : []),
      ...(call?.cacheReadInputTokens !== undefined && call.inputTokens > 0
        ? [
            `${percent(call.cacheReadInputTokens / call.inputTokens)} of the last call read from cache`,
          ]
        : []),
    ],
  }
}

/** `just now`, `12m ago`, `3h ago`, `2d ago`. */
function ago(then: number, now: number): string {
  const minutes = Math.round((now - then) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** `950`, `9.5k`, `38k`, `984k`, `1.2M`. */
function tokenCount(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 10_000) return `${Math.round(tokens / 100) / 10}k`
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`
  return `${Math.round(tokens / 100_000) / 10}M`
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
