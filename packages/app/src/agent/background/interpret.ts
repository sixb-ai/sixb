import type { AgentConversationMessage } from "../conversation"
import type { AgentMessages } from "../i18n/en"
import type { NormalizedTool } from "../parts"
import { toolResultValue } from "../parts"
import { COMMAND_TOOLS, isStop, namedIds } from "../waits"

// A command the agent runs in the background outlives the call that started it: later calls wait
// for it (`wait`) or stop it (`stop`), maybe turns later, and on the owner's computer the
// open `sixb` reports how it stands between turns. The chat shows it as one card in the work's
// steps, in place of its start, merging all of these: only a reader who opens the steps sees it.

export type BackgroundCommandStatus = "running" | "exited" | "stopped"

/** The tools that start, read and stop a background command, earlier threads' included. */
export const BACKGROUND_TOOLS: ReadonlySet<string> = new Set(["bash", ...COMMAND_TOOLS])

/** How much of what the agent read of a command the card keeps: its newest characters. */
const OUTPUT_TAIL_CHARS = 8_000

/** A background command by its start: an id is unique to its run, its start to the thread. */
export function backgroundKey(command: { readonly id: string; readonly startedAt: string }) {
  return `${command.id}@${command.startedAt}`
}

/** A command a work group started, which its card stands for under the work. */
export type BackgroundStart =
  /** The call is on its way: the command does not run yet. */
  | { readonly kind: "starting"; readonly key: string; readonly command: string }
  | {
      readonly kind: "started"
      readonly key: string
      readonly id: string
      readonly startedAt: string
      readonly command: string
    }

/** What the conversation's calls say of a command, oldest to newest. */
export interface CommandFromCalls {
  readonly id: string
  readonly command: string
  readonly startedAt: string
  readonly status: BackgroundCommandStatus
  readonly exitCode?: number
  readonly endedAt?: string
  readonly outputPath?: string
  /** The turn that started it. */
  readonly runId: string | null
  /** What the agent read of its output, newest last; `truncated` when more came before. */
  readonly output: string
  readonly truncated: boolean
  /** A call naming it is on its way: the agent reads it, waits for it, or stops it. */
  readonly pending?: "reading" | "waiting" | "stopping"
}

/** The thread's background commands as its calls tell them, by {@link backgroundKey}. */
export interface ThreadBackground {
  readonly commands: ReadonlyMap<string, CommandFromCalls>
}

/** A command as the computer's `sixb` reports it to its owner, between turns too. */
export interface LiveBackgroundCommand {
  readonly id: string
  readonly command: string
  readonly status: BackgroundCommandStatus
  readonly exitCode?: number
  readonly startedAt: string
  readonly endedAt?: string
  /** A stop its owner asked for is on its way to it. */
  readonly stopping?: boolean
}

/** Where the thread's commands run, and what is known of them now. */
export interface BackgroundSource {
  /** The thread runs on its owner's computer, where a command outlives its turn. */
  readonly onComputer: boolean
  /**
   * What the computer reports, to its owner alone: null for anyone else, and in the cloud. Empty
   * when `sixb` is closed there, which stopped them.
   */
  readonly live: readonly LiveBackgroundCommand[] | null
  /** `sixb` is open in the thread's folder. */
  readonly online: boolean
}

/** How the card shows a command now. */
export interface BackgroundCardState {
  readonly status: "starting" | BackgroundCommandStatus | "unknown"
  readonly command: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly exitCode?: number
  /** Why a command its calls last saw running is gone: its turn, or its `sixb`, ended. */
  readonly endedWith?: "turn" | "sixb"
  /** Unknown as its owner's `sixb` does not answer there: closed, or offline. */
  readonly unreachable?: boolean
  /** A stop is on its way: the agent's, or one its owner asked for. */
  readonly stopping: boolean
  /** The agent waits for it, or reads it, now. */
  readonly pending?: "reading" | "waiting"
  /** Its owner can stop it from the card: it runs on their open `sixb`. */
  readonly canStop: boolean
  readonly output: string
  readonly truncated: boolean
  readonly outputPath?: string
}

/**
 * The command a background start stands for, by its call: on its way, or started with its id. Null
 * for one that could not start, which is a failed call like any other.
 */
export function backgroundStartOf(tool: NormalizedTool): BackgroundStart | null {
  if (!isBackgroundStart(tool)) return null

  const command = commandOf(tool)
  if (tool.state === "input-streaming" || tool.state === "input-available") {
    return { kind: "starting", key: "starting", command }
  }
  const state = tool.state === "output-available" ? commandState(tool.output) : null
  if (!state) return null
  return {
    kind: "started",
    key: backgroundKey(state),
    id: state.id,
    startedAt: state.startedAt,
    command: command || state.command,
  }
}

/** Whether a call starts a command in the background. */
export function isBackgroundStart(tool: NormalizedTool): boolean {
  return tool.toolName === "bash" && isRecord(tool.input) && tool.input.run_in_background === true
}

/** Read the thread's background commands from its turns, oldest first, the one streaming last. */
export function readThreadBackground(
  messages: readonly Pick<AgentConversationMessage, "role" | "runId" | "parts">[]
): ThreadBackground {
  const commands = new Map<string, CommandFromCalls>()
  // The newest command by id: a call on its way names one by id alone.
  const byId = new Map<string, string>()

  const merge = (key: string, change: Partial<CommandFromCalls>) => {
    const current = commands.get(key)
    if (current) commands.set(key, { ...current, ...change })
  }

  for (const message of messages) {
    if (message.role !== "assistant") continue

    for (const part of message.parts) {
      if (part.type !== "tool" || !BACKGROUND_TOOLS.has(part.toolName)) continue
      const tool = part as NormalizedTool

      if (tool.toolName === "bash") {
        const state =
          isBackgroundStart(tool) && tool.state === "output-available"
            ? commandState(tool.output)
            : null
        if (!state) continue

        const key = backgroundKey(state)
        commands.set(key, {
          ...state,
          command: commandOf(tool) || state.command,
          runId: message.runId,
          output: "",
          truncated: false,
        })
        byId.set(state.id, key)
        continue
      }

      // A read or a stop on its way names the commands it is for.
      if (tool.state === "input-streaming" || tool.state === "input-available") {
        const pending = isStop(tool) ? "stopping" : waits(tool) ? "waiting" : "reading"
        for (const id of namedIds(tool)) {
          const key = byId.get(id)
          if (key) merge(key, { pending })
        }
        continue
      }
      if (tool.state !== "output-available") continue

      for (const report of reportsOf(tool)) {
        const read = commandState(report)
        if (!read) continue
        const key = backgroundKey(read)
        const known = commands.get(key)
        // Its start is beyond what the conversation shows: the read stands for it.
        const current: CommandFromCalls = known ?? {
          ...read,
          runId: message.runId,
          output: "",
          truncated: false,
        }
        byId.set(read.id, key)

        const written = typeof outputOf(report)?.output === "string" ? outputOf(report)?.output : ""
        const skipped = Number(outputOf(report)?.skippedBytes ?? 0) > 0
        const joined = current.output + (written ?? "")
        // An end is final: a later read never says it runs again.
        const ended = current.status !== "running" ? current : read
        const { pending: _pending, ...rest } = current
        commands.set(key, {
          ...rest,
          status: ended.status,
          ...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }),
          ...(ended.endedAt === undefined ? {} : { endedAt: ended.endedAt }),
          output: joined.slice(-OUTPUT_TAIL_CHARS),
          truncated: current.truncated || skipped || joined.length > OUTPUT_TAIL_CHARS,
        })
      }
    }
  }

  return { commands }
}

/**
 * How a command's card reads now: its calls, what its `sixb` reports, and whether its turn still
 * works. Whatever says it ended wins; a command its calls last saw running is gone once nothing can
 * still run it: its turn ended in the cloud, or its `sixb` closed or no longer reports it.
 */
export function backgroundCardState(input: {
  readonly start: BackgroundStart
  readonly calls?: CommandFromCalls
  readonly source: BackgroundSource
  /** The turn streaming now, if any. */
  readonly liveRunId: string | null
  /** A stop the reader asked for here, until the computer reports it. */
  readonly stopAsked?: boolean
}): BackgroundCardState {
  const { start, calls, source } = input
  const empty = { output: "", truncated: false, stopping: false, canStop: false }
  if (start.kind === "starting") return { ...empty, status: "starting", command: start.command }

  const live = source.live?.find((command) => backgroundKey(command) === start.key)
  const base = {
    command: start.command,
    startedAt: start.startedAt,
    output: calls?.output ?? "",
    truncated: calls?.truncated ?? false,
    ...(calls?.outputPath ? { outputPath: calls.outputPath } : {}),
  }

  const ended = [calls, live].find((each) => each !== undefined && each.status !== "running")
  if (ended) {
    return {
      ...base,
      status: ended.status,
      ...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }),
      ...(ended.endedAt === undefined ? {} : { endedAt: ended.endedAt }),
      stopping: false,
      canStop: false,
    }
  }

  const agentStopping = calls?.pending === "stopping"
  const pending =
    calls?.pending === "reading" || calls?.pending === "waiting" ? calls.pending : undefined
  const running = {
    ...base,
    status: "running" as const,
    ...(pending ? { pending } : {}),
  }
  if (live) {
    const stopping = agentStopping || live.stopping === true || input.stopAsked === true
    return { ...running, stopping, canStop: !stopping }
  }

  // Its turn still works: the command runs, and `sixb` has not reported it yet.
  const turnWorks =
    calls?.runId !== null && calls?.runId !== undefined && calls.runId === input.liveRunId
  if (turnWorks || (!calls && input.liveRunId !== null)) {
    return { ...running, stopping: agentStopping, canStop: false }
  }

  const gone = { ...base, status: "stopped" as const, stopping: false, canStop: false }
  // In the cloud, a turn's commands stop as it ends.
  if (!source.onComputer) return { ...gone, endedWith: "turn" }
  // Its open sixb no longer runs it: it restarted, and stopped it as it quit.
  if (source.live !== null && source.online) return { ...gone, endedWith: "sixb" }
  // sixb is closed there, or keeps its commands from the web, or the computer is someone else's:
  // nothing says how it stands now.
  return {
    ...base,
    status: "unknown",
    ...(source.live !== null ? { unreachable: true } : {}),
    stopping: false,
    canStop: false,
  }
}

/** What a background call reads as, in the work and as the live label of a turn at work. */
export function backgroundRowLabel(tool: NormalizedTool, messages: AgentMessages): string {
  const rows = messages.background.rows
  const row = isStop(tool)
    ? rows.stop
    : COMMAND_TOOLS.has(tool.toolName)
      ? waits(tool)
        ? rows.wait
        : rows.read
      : rows.start
  return tool.state === "input-streaming" || tool.state === "input-available"
    ? row.running
    : row.title
}

/** The command a call names in its input, as the model wrote it. */
function commandOf(tool: NormalizedTool): string {
  const input = isRecord(tool.input) ? tool.input : {}
  if (typeof input.command === "string") return input.command
  const partial = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(tool.inputText ?? "")
  return partial?.[1] ? partial[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : ""
}

/** A command's state, as its tools return it. */
function commandState(output: unknown): {
  readonly id: string
  readonly command: string
  readonly startedAt: string
  readonly status: BackgroundCommandStatus
  readonly exitCode?: number
  readonly endedAt?: string
  readonly outputPath?: string
} | null {
  const value = outputOf(output)
  if (!value) return null
  const { id, command, startedAt, status, exitCode, endedAt, outputPath } = value
  if (typeof id !== "string" || typeof startedAt !== "string") return null
  if (status !== "running" && status !== "exited" && status !== "stopped") return null

  return {
    id,
    command: typeof command === "string" ? command : "",
    startedAt,
    status,
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof endedAt === "string" ? { endedAt } : {}),
    ...(typeof outputPath === "string" ? { outputPath } : {}),
  }
}

/** Whether a call waits for its commands to end: `wait` unless told 0, `bash_output` when told. */
function waits(tool: NormalizedTool): boolean {
  const input = isRecord(tool.input) ? tool.input : {}
  if (tool.toolName === "wait") return input.timeoutMs !== 0
  return typeof input.wait === "number" && input.wait > 0
}

/** What a call reports of each command: `wait` and `stop` list theirs, earlier tools one. */
function reportsOf(tool: NormalizedTool): readonly unknown[] {
  if (tool.toolName !== "wait" && tool.toolName !== "stop") return [tool.output]
  const value = toolResultValue(tool.output)
  return isRecord(value) && Array.isArray(value.commands) ? value.commands : []
}

function outputOf(output: unknown): Record<string, unknown> | null {
  const value = toolResultValue(output)
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
