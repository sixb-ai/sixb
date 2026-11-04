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
      // Started in the background: it runs on, and its id is what later calls name.
      if (input?.run_in_background === true) {
        const id = text(output?.id)
        return {
          verb: "bash",
          command: command.trim(),
          detail: firstLine(command) + (command.includes("\n") ? " …" : ""),
          note: id ? `in the background · ${id}` : "in the background",
          ...error,
        }
      }
      const exitCode = typeof output?.exitCode === "number" ? output.exitCode : undefined
      const timedOut = output?.timedOut === true
      const stdout = text(output?.stdout)
      const stderr = timedOut ? withoutAgentNotice(text(output?.stderr)) : text(output?.stderr)
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
            : timedOut
              ? { note: `timed out after ${commandTimeoutText(input?.timeoutMs)}`, failed: true }
              : exitCode !== undefined && exitCode !== 0
                ? { note: `exit ${exitCode}`, failed: true }
                : {}),
        ...error,
      }
    }
    case "bash_output":
    case "bash_stop": {
      const output_ = text(output?.output)
      const status = text(output?.status)
      return {
        verb: part.name === "bash_stop" ? "stop" : "output",
        detail: [text(input?.id), firstLine(text(output?.command))].filter(Boolean).join("  "),
        ...(output_.trim() ? { preview: lines(output_) } : {}),
        ...(status ? backgroundNote(status, output?.exitCode) : {}),
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
    case "web_search": {
      const results = Array.isArray(output?.results) ? output.results.length : undefined
      return {
        verb: "search",
        detail: firstLine(text(input?.query)),
        ...(results !== undefined ? { note: plural(results, "result") } : {}),
        ...error,
      }
    }
    case "web_fetch":
      return {
        verb: "fetch",
        detail: webAddress(text(input?.url)),
        ...fetchNote(output),
        ...(failed ? fetchFailure(part.error) : {}),
      }
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

/** How long a command had, as the bash tool gives it: 2 minutes unless it asked, 10 at most. */
function commandTimeoutText(timeoutMs: unknown): string {
  const ms =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.floor(timeoutMs), 10 * 60_000)
      : 2 * 60_000
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/**
 * A timed-out command's stderr without the line the bash tool adds for the model (how long it
 * had, how to ask for more): the note beside the line says it for people.
 */
function withoutAgentNotice(stderr: string): string {
  return stderr.replace(/(^|\n)\[SixbAgent\] [^\n]*$/, "")
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

/** An address as host and path: the scheme, query and fragment say nothing on one line. */
function webAddress(value: string): string {
  try {
    const url = new URL(value)
    return url.pathname === "/" ? url.host : `${url.host}${url.pathname}`
  } catch {
    return firstLine(value)
  }
}

function webHost(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return firstLine(value)
  }
}

/** What came of a page read: the site it pointed to instead, an answer, or the file it filled. */
function fetchNote(output: Record<string, unknown> | undefined): Pick<ToolLine, "note"> {
  const redirect = record(output?.redirect)
  if (redirect) return { note: `→ ${webHost(text(redirect.url))}` }
  if (typeof output?.answer === "string") return { note: "answered" }
  if (typeof output?.path === "string" && typeof output.bytes === "number") {
    return { note: `saved ${byteSize(output.bytes)}` }
  }
  return {}
}

/**
 * A failed read as a short reason beside the address, which a full error would squeeze off the
 * line, and the error itself under it, as a failed command's output.
 */
function fetchFailure(error: string | undefined): Pick<ToolLine, "note" | "failed" | "preview"> {
  const detail = firstLine(error ?? "").replace(/^\[\w+\]\s*/, "")
  const note = /^Blocked:/.test(detail)
    ? "blocked"
    : /\bECONNREFUSED\b/.test(detail)
      ? "refused"
      : /^Timed out\b/.test(detail)
        ? "timed out"
        : "failed"

  return { note, failed: true, ...(detail ? { preview: [detail] } : {}) }
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** How a background command stands, beside its line. */
function backgroundNote(status: string, exitCode: unknown): Pick<ToolLine, "note" | "failed"> {
  if (status === "running") return { note: "running" }
  if (status === "stopped") return { note: "stopped" }
  if (typeof exitCode !== "number") return { note: "exited" }
  return exitCode === 0 ? { note: "exit 0" } : { note: `exit ${exitCode}`, failed: true }
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
    const command = /"(?:command|path|task|key|query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(inputText)
    const value = command?.[1]
    return value !== undefined
      ? { command: value, path: value, task: value, query: value, url: value }
      : undefined
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

/** A clock that ticks by the second: `8s`, `2m 14s`, `1h 03m`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${seconds}s`
}

/** A background command as `sixb` reports it. */
export interface BackgroundCommand {
  readonly id: string
  readonly command: string
  readonly status: "running" | "exited" | "stopped"
  readonly exitCode?: number
  readonly startedAt: string
  readonly endedAt?: string
}

/** A command's first line, cut to `max` characters. */
export function commandLabel(command: string, max = 40): string {
  const line = firstLine(command)
  const cut = line.length > max ? `${line.slice(0, max - 1)}…` : line
  return cut + (command.trim().includes("\n") && cut === line ? " …" : "")
}

/**
 * The running background commands as the line over the composer lists them, `● bun run dev 2m
 * 14s`, as many as fit in `room` columns, oldest first; `more` counts the rest.
 */
export function backgroundStrip(
  commands: readonly BackgroundCommand[],
  now: number,
  room: number
): {
  readonly shown: readonly { readonly label: string; readonly time: string }[]
  readonly more: number
} {
  const running = commands
    .filter((command) => command.status === "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const shown: { label: string; time: string }[] = []
  let used = 0
  for (const [index, command] of running.entries()) {
    const entry = {
      label: commandLabel(command.command, 32),
      time: elapsed(now - Date.parse(command.startedAt)),
    }
    // `● label time`, then three spaces; the rest is said as `+2 more`.
    const width = entry.label.length + entry.time.length + 3 + (shown.length > 0 ? 3 : 0)
    const rest = running.length - index - 1
    const suffix = rest > 0 ? `   +${rest} more`.length : 0
    if (shown.length > 0 && used + width + suffix > room) break
    shown.push(entry)
    used += width
  }
  return { shown, more: running.length - shown.length }
}

/** What the screen says as a background command ends: its notice, and whether it failed. */
export function backgroundEnded(command: BackgroundCommand): {
  readonly text: string
  readonly failed: boolean
} {
  const label = commandLabel(command.command, 48)
  const ran = command.endedAt
    ? ` after ${elapsed(Date.parse(command.endedAt) - Date.parse(command.startedAt))}`
    : ""
  if (command.status === "stopped") return { text: `${label} stopped${ran}`, failed: false }
  const code = command.exitCode ?? 0
  return { text: `${label} exited with code ${code}${ran}`, failed: code !== 0 }
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
    /\/(?:private\/)?(?:var|tmp)\/[^\s"']*?\/sixb-agent\/[^/\s"']+\/(?:\.sixb\/agent\/)?/g,
    "run/"
  )
  if (folder) {
    const prefixes = [folder, folder.replace(/^\/private/, "")].map((prefix) => `${prefix}/`)
    for (const prefix of prefixes) shown = shown.split(prefix).join("")
  }
  return shown
}
