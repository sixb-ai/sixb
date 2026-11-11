import { type AgentMessage, stableJsonStringify } from "@sixb/core"
import type { ModelTool } from "@sixb/core/models"
import type { BackgroundCommandState, BackgroundCommands } from "./background-commands"
import { reportedCommands } from "./tools/background"

/** A command's displayed form in a notice: its first line, cut. */
const NOTICE_COMMAND_CHARS = 80

/** A notice's line that tells a command ended, and its id. */
const ENDED_LINE = /^Background command (\S+) \(`.*?`\) (?:exited with code|was stopped)/gm

/**
 * How a run hears of its background commands without polling: a short notice closing the result
 * of the first tool that returns after one ended, and, on its first, those of an earlier turn
 * still running and those its history left running that ended with their run. A tool's result is
 * what its message part keeps (`modelOutput`), so a later turn replays the notice where the model
 * read it, byte for byte; no other request is touched.
 */
export class BackgroundNotices {
  /** What the run's first notice says of earlier runs, until it is taken. */
  #earlier:
    | {
        readonly running: readonly string[]
        readonly gone: readonly BackgroundCommandState[]
      }
    | undefined

  /** What ended the commands of earlier runs that this run's do not know. */
  readonly #endedWith: string

  constructor(
    private readonly commands: BackgroundCommands,
    options: {
      /** The commands the history last read as running ({@link backgroundCommandsLeftRunning}). */
      readonly leftRunning?: readonly BackgroundCommandState[]
      /** What ended those this run's commands do not know: the run, or the `sixb`, that ran them. */
      readonly endedWith?: string
    } = {}
  ) {
    this.#earlier = {
      running: commands
        .list()
        .filter((command) => command.status === "running")
        .map((command) => command.id),
      gone: (options.leftRunning ?? []).filter((command) => !commands.has(command.id)),
    }
    this.#endedWith = options.endedWith ?? "the run that started it"
  }

  /** The notice due now, once: undefined when nothing is new. */
  take(now = new Date()): string | undefined {
    const earlier = this.#earlier
    this.#earlier = undefined

    const running = (earlier?.running ?? [])
      .map((id) => this.commands.get(id))
      .filter((command) => command.status === "running")
    const lines = [
      ...(earlier?.gone ?? []).map(
        (command) =>
          `Background command ${command.id} (\`${shortCommand(command.command)}\`) was stopped when ${this.#endedWith} ended; its output file is gone.`
      ),
      ...running.map((command) => runningLine(command, now)),
      ...this.commands.takeEnded().map(endedLine),
    ]
    if (lines.length === 0) return undefined
    return `<sixb_background_commands>\n${lines.join("\n")}\n</sixb_background_commands>`
  }

  /** The run's tools, each result closed by the notice due as it returns. */
  wrap(tools: readonly ModelTool[]): ModelTool[] {
    return tools.map((tool) => ({
      ...tool,
      toModelOutput: async (output, context) => {
        const projected = tool.toModelOutput
          ? await tool.toModelOutput(output, context)
          : typeof output === "string"
            ? { type: "text" as const, value: output }
            : { type: "json" as const, value: output }
        // An error result says nothing else: the notice waits for the next one.
        if (projected.type !== "text" && projected.type !== "json") return projected

        const notice = this.take()
        if (notice === undefined) return projected

        // Keys sorted, as providers print a JSON output; the bytes are kept as the model read them.
        const text =
          projected.type === "text" ? projected.value : stableJsonStringify(projected.value)
        return { type: "text", value: `${text}\n\n${notice}` }
      },
    }))
  }
}

/**
 * The background commands a history last read as running: their tools reported them so, and no
 * later result or notice said they ended. A run whose own commands do not know them is told they
 * ended with the run, or the `sixb`, that ran them.
 */
export function backgroundCommandsLeftRunning(
  messages: readonly Pick<AgentMessage, "parts">[]
): readonly BackgroundCommandState[] {
  const running = new Map<string, BackgroundCommandState>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call" || part.state !== "output-available") continue

      for (const command of reportedCommands(part.toolName, part.output)) {
        if (!isCommandState(command)) continue
        if (command.status === "running") running.set(command.id, command)
        else running.delete(command.id)
      }
      if (part.modelOutput?.type === "text") {
        for (const [, id] of part.modelOutput.value.matchAll(ENDED_LINE)) {
          if (id !== undefined) running.delete(id)
        }
      }
    }
  }
  return [...running.values()]
}

function isCommandState(value: unknown): value is BackgroundCommandState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false

  const state = value as Record<string, unknown>
  return (
    typeof state.id === "string" &&
    state.id.startsWith("bg_") &&
    typeof state.command === "string" &&
    typeof state.status === "string"
  )
}

/** How an ended command reads in a notice. */
function endedLine(command: BackgroundCommandState): string {
  const ran = formatDuration(
    new Date(command.endedAt ?? command.startedAt).getTime() - new Date(command.startedAt).getTime()
  )
  const how =
    command.status === "stopped"
      ? "was stopped"
      : `exited with code ${command.exitCode ?? "unknown"}`
  return `Background command ${command.id} (\`${shortCommand(command.command)}\`) ${how} after ${ran}. Output: ${command.outputPath}`
}

/** How a command still running from an earlier turn reads in a notice. */
function runningLine(command: BackgroundCommandState, now: Date): string {
  const since = formatDuration(now.getTime() - new Date(command.startedAt).getTime())
  return `Background command ${command.id} (\`${shortCommand(command.command)}\`) is still running, started ${since} ago in an earlier turn. Output: ${command.outputPath}`
}

/** A command's display in a notice: its first line, cut. */
function shortCommand(command: string): string {
  const line = command.trim().split("\n")[0] ?? ""
  const cut = line.length > NOTICE_COMMAND_CHARS ? `${line.slice(0, NOTICE_COMMAND_CHARS)}…` : line
  return cut + (command.trim().includes("\n") ? " …" : "")
}

/** `2m14s`, `850ms`. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`

  const seconds = Math.round(ms / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, "0")}s`
  return `${rest}s`
}
