import { posix } from "node:path"
import {
  AgentToolPublicError,
  type CommandResult,
  type Sandbox,
  stableJsonStringify,
} from "@sixb/core"
import type { ModelTool } from "@sixb/core/models"
import { type AgentSandboxHandle, contextPath } from "./sandbox-handle"

// A background command runs in the call that starts it, held open until it ends: a provider that
// kills what a call left behind once it returns (a cgroup, a PID namespace) leaves it alone, and
// it needs nothing of a provider but `runCommand`. It runs in a process group of its own, which
// `bash_stop` signals from inside the sandbox; the held call's abort is the fallback where another
// call cannot reach it. Its output goes to a file in the run's context directory, which the agent
// reads with `read` as any other file.

/** Where the commands' files go, in the run's context directory. */
export const BACKGROUND_DIRECTORY = "background"

/** At most this many of a run's background commands run at once. */
const MAX_RUNNING = 16

/** What one read returns of its output: its newest bytes, as `bash` bounds a stream. */
const OUTPUT_MAX_BYTES = 20_000

/**
 * The held call's own bound, under every provider's 32-bit timer: a command that runs a week is
 * stopped like any other.
 */
const HELD_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

/** How long a stopped command has to exit on SIGTERM before it is killed. */
const STOP_GRACE_MS = 3_000

/** The short calls that start, signal and read a command. */
const CONTROL_TIMEOUT_MS = 15_000

/** A command's displayed form in a notice: its first line, cut. */
const NOTICE_COMMAND_CHARS = 80

export type BackgroundCommandStatus = "running" | "exited" | "stopped"

/** A background command as its tools report it, and as a chat can show it. */
export interface BackgroundCommandState {
  /** `bg_<n>`: the id `bash_output` and `bash_stop` take. */
  readonly id: string
  readonly command: string
  readonly status: BackgroundCommandStatus
  /**
   * Its exit code once it ended. A stopped command's is the signal's (143 for SIGTERM, 137 for
   * SIGKILL), or absent when its sandbox went away under it.
   */
  readonly exitCode?: number
  /** ISO timestamps. */
  readonly startedAt: string
  readonly endedAt?: string
  /** The file holding everything it wrote, stdout and stderr together, as the agent names it. */
  readonly outputPath: string
}

/** What `bash_output` and `bash_stop` return: its state, and what it wrote since the last read. */
export interface BackgroundCommandOutput extends BackgroundCommandState {
  /** What it wrote since the last read: its newest 20,000 bytes at most. */
  readonly output: string
  /** What it wrote since the last read that `output` leaves out, ahead of it: in the file. */
  readonly skippedBytes?: number
}

interface BackgroundCommand {
  readonly id: string
  readonly command: string
  readonly startedAt: Date
  readonly paths: { readonly output: string; readonly pid: string; readonly exit: string }
  /** The sandbox it runs in, which signals it: a later run may have another. */
  readonly sandbox: Sandbox
  /** Aborts the held call: the provider kills what it ran. */
  readonly abort: AbortController
  /** Settles once it ended, however it did. */
  readonly ended: Promise<void>
  /** Its process group, once it started. */
  group?: number
  status: BackgroundCommandStatus
  exitCode?: number
  endedAt?: Date
  /** What the wrapper or the sandbox said, when it could not start the command. */
  failure?: string
  /** Its stop, once asked for. */
  stopping?: Promise<void>
  /** How many bytes of its output the agent has read. */
  readBytes: number
  /** Its end reached the model, through a tool's result or a notice. */
  reported: boolean
}

/**
 * The background commands of a run, or of a thread on the user's computer, where they outlive
 * the turn that started them. Their state is in memory; their output, pid and exit code are files
 * in the sandbox.
 */
export class BackgroundCommands {
  readonly #commands = new Map<string, BackgroundCommand>()
  #next = 1

  /** Whether it ever started one: its files are then worth keeping for a later turn. */
  get isEmpty(): boolean {
    return this.#commands.size === 0
  }

  /**
   * Start `command` in the background and return once it runs, its output going to its file. One
   * the sandbox could not start, as in a directory that does not exist, throws what it said.
   */
  async start(input: {
    readonly handle: AgentSandboxHandle
    readonly command: string
    readonly cwd?: string
  }): Promise<BackgroundCommandState> {
    const running = [...this.#commands.values()].filter((entry) => entry.status === "running")
    if (running.length >= MAX_RUNNING) {
      throw new AgentToolPublicError(
        `[SixbAgent] ${MAX_RUNNING} background commands are running already: stop one with bash_stop first.`
      )
    }

    const { handle } = input
    const { sandbox } = handle
    const id = `bg_${this.#next++}`
    const directory = contextPath(handle, BACKGROUND_DIRECTORY)
    const paths = {
      output: posix.join(directory, `${id}.log`),
      pid: posix.join(directory, `${id}.pid`),
      exit: posix.join(directory, `${id}.exit`),
    }
    const abort = new AbortController()

    const held = sandbox.runCommand(
      "bash",
      ["-c", START_SCRIPT, "sixb-background", paths.output, paths.pid, paths.exit, input.command],
      {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(handle.env === undefined ? {} : { env: handle.env }),
        timeout: HELD_TIMEOUT_MS,
        signal: abort.signal,
      }
    )
    const entry: BackgroundCommand = {
      id,
      command: input.command,
      startedAt: new Date(),
      paths,
      sandbox,
      abort,
      ended: held.then(
        (result) => this.#end(entry, result),
        (error: unknown) => this.#end(entry, undefined, error)
      ),
      status: "running",
      readBytes: 0,
      reported: false,
    }
    this.#commands.set(id, entry)

    // Its group is known once the wrapper wrote it, which it does first: until then nothing could
    // signal it, so `start` returns only then, or once it ended without starting.
    const group = await Promise.race([
      readGroup(sandbox, paths.pid, handle.env).catch(() => undefined),
      entry.ended.then(() => undefined),
    ])
    if (group !== undefined) entry.group = group

    if (entry.failure !== undefined) {
      this.#commands.delete(id)
      throw new AgentToolPublicError(`[SixbAgent] The command could not start: ${entry.failure}`)
    }
    if (entry.status !== "running") entry.reported = true
    return state(entry)
  }

  /** A command by id, or a public error the model can act on. */
  get(id: string): BackgroundCommandState {
    return state(this.#find(id))
  }

  /** Every command, oldest first. */
  list(): readonly BackgroundCommandState[] {
    return [...this.#commands.values()].map(state)
  }

  /**
   * Wait until the command ends, `timeoutMs` elapses or `signal` aborts, which rejects with its
   * reason.
   */
  async wait(id: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const entry = this.#find(id)
    if (entry.status !== "running" || timeoutMs <= 0) return

    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, timeoutMs)
      void entry.ended.then(finish)
      signal.addEventListener("abort", abort, { once: true })

      function finish(): void {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        resolve()
      }
      function abort(): void {
        clearTimeout(timer)
        reject(signal.reason)
      }
    })
  }

  /**
   * Its state and what it wrote since the last read, read through `handle`: the sandbox of the run
   * that asks. Once it reports the command ended, no notice repeats it.
   */
  async read(
    id: string,
    handle: AgentSandboxHandle,
    signal: AbortSignal
  ): Promise<BackgroundCommandOutput> {
    const entry = this.#find(id)
    // Its state before its output: a command that ended then wrote all it will.
    const snapshot = state(entry)
    const result = await handle.sandbox.runCommand(
      "bash",
      [
        "-c",
        READ_SCRIPT,
        "sixb-background-read",
        entry.paths.output,
        String(entry.readBytes),
        String(OUTPUT_MAX_BYTES),
      ],
      {
        ...(handle.env === undefined ? {} : { env: handle.env }),
        timeout: CONTROL_TIMEOUT_MS,
        signal,
      }
    )
    signal.throwIfAborted()
    if (result.exitCode !== 0) {
      throw new AgentToolPublicError(
        `[SixbAgent] Could not read the output of ${id} at ${entry.paths.output}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      )
    }

    const newline = result.stdout.indexOf("\n")
    const size = Number(result.stdout.slice(0, newline === -1 ? undefined : newline))
    const output = newline === -1 ? "" : result.stdout.slice(newline + 1)
    const unread = Math.max(0, size - entry.readBytes)
    const skippedBytes = Math.max(0, unread - OUTPUT_MAX_BYTES)
    entry.readBytes = Math.max(entry.readBytes, size)
    if (snapshot.status !== "running") entry.reported = true

    return { ...snapshot, output, ...(skippedBytes > 0 ? { skippedBytes } : {}) }
  }

  /**
   * Stop the command and everything it started: SIGTERM to its process group, SIGKILL after a
   * grace period or where the sandbox cannot reach it, then the held call's abort. Resolves once
   * it ended.
   */
  async stop(id: string): Promise<BackgroundCommandState> {
    const entry = this.#find(id)
    if (entry.status === "running") {
      entry.stopping ??= this.#stop(entry)
      await entry.stopping
    }
    return state(entry)
  }

  async #stop(entry: BackgroundCommand): Promise<void> {
    if (await signalGroup(entry, "TERM")) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        entry.ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_GRACE_MS)
        }),
      ])
      clearTimeout(timer)
    }

    if (entry.status === "running") {
      await signalGroup(entry, "KILL")
      entry.abort.abort()
      await entry.ended
    }
  }

  /** Stop every command still running. */
  async stopAll(): Promise<void> {
    const running = [...this.#commands.values()].filter((entry) => entry.status === "running")
    await Promise.all(running.map((entry) => this.stop(entry.id)))
  }

  /**
   * Settles once no command started in `sandbox` runs; undefined when none does now. A computer
   * keeps a turn's sandbox until then.
   */
  endOf(sandbox: Sandbox): Promise<void> | undefined {
    const running = [...this.#commands.values()].filter(
      (entry) => entry.sandbox === sandbox && entry.status === "running"
    )
    if (running.length === 0) return undefined
    return Promise.all(running.map((entry) => entry.ended)).then(() => {})
  }

  /** The commands that ended and the model has not heard of: each is reported once. */
  takeEnded(): readonly BackgroundCommandState[] {
    const ended = [...this.#commands.values()].filter(
      (entry) => entry.status !== "running" && !entry.reported
    )
    for (const entry of ended) entry.reported = true
    return ended.map(state)
  }

  #find(id: string): BackgroundCommand {
    const entry = this.#commands.get(id)
    if (!entry) {
      const known = [...this.#commands.keys()]
      throw new AgentToolPublicError(
        `[SixbAgent] No background command '${id}'${known.length > 0 ? `: the known ones are ${known.join(", ")}` : ""}.`
      )
    }
    return entry
  }

  #end(entry: BackgroundCommand, result: CommandResult | undefined, error?: unknown): void {
    entry.status = entry.stopping ? "stopped" : "exited"
    entry.endedAt = new Date()
    if (result) {
      entry.exitCode = result.exitCode
      // The wrapper writes nothing of its own unless it, or the sandbox, could not run it.
      if (result.stderr.trim() && entry.group === undefined) entry.failure = result.stderr.trim()
    } else {
      // Its sandbox went away under it, or never ran it.
      entry.status = "stopped"
      console.warn(`[SixbAgent] Background command ${entry.id} ended with its sandbox:`, error)
    }

    // Past its bound, the held call's abort stopped the wrapper, not the group it started.
    if (result?.timedOut) void signalGroup(entry, "KILL")
  }
}

/**
 * How a run hears of its background commands without polling: a short notice closing the result
 * of the first tool that returns after one ended, and, on its first, those of an earlier turn
 * still running. A tool's result is what its message part keeps (`modelOutput`), so a later turn
 * replays the notice where the model read it, byte for byte; no other request is touched.
 */
export class BackgroundNotices {
  /** The commands of earlier turns running as the run started, until its first notice. */
  #runningAtStart: readonly string[] | undefined

  constructor(private readonly commands: BackgroundCommands) {
    this.#runningAtStart = commands
      .list()
      .filter((command) => command.status === "running")
      .map((command) => command.id)
  }

  /** The notice due now, once: undefined when nothing is new. */
  take(now = new Date()): string | undefined {
    const earlier = this.#runningAtStart ?? []
    this.#runningAtStart = undefined

    const ended = this.commands.takeEnded()
    const running = earlier
      .map((id) => this.commands.get(id))
      .filter((command) => command.status === "running")
    const lines = [...running.map((command) => runningLine(command, now)), ...ended.map(endedLine)]
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

/** A command's state, as its tools return it. */
function state(entry: BackgroundCommand): BackgroundCommandState {
  return {
    id: entry.id,
    command: entry.command,
    status: entry.status,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    startedAt: entry.startedAt.toISOString(),
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt.toISOString() }),
    outputPath: entry.paths.output,
  }
}

/** The process group the wrapper wrote, waited for in the sandbox. */
async function readGroup(
  sandbox: Sandbox,
  path: string,
  env: Readonly<Record<string, string>> | undefined
): Promise<number | undefined> {
  const result = await sandbox.runCommand("bash", ["-c", GROUP_SCRIPT, "sixb-background", path], {
    ...(env === undefined ? {} : { env }),
    timeout: CONTROL_TIMEOUT_MS,
  })
  const group = Number(result.stdout.trim())
  return result.exitCode === 0 && Number.isSafeInteger(group) && group > 1 ? group : undefined
}

/**
 * Signal its process group from inside the sandbox it runs in. False when nothing received it:
 * no group known yet, or one this sandbox cannot see, as a command run under a PID namespace of
 * its own.
 */
async function signalGroup(entry: BackgroundCommand, signal: "TERM" | "KILL"): Promise<boolean> {
  if (entry.group === undefined) return false

  try {
    const result = await entry.sandbox.runCommand(
      "bash",
      ["-c", 'kill -s "$1" -- "-$2" 2>/dev/null', "sixb-background", signal, String(entry.group)],
      { timeout: CONTROL_TIMEOUT_MS }
    )
    return result.exitCode === 0
  } catch {
    return false
  }
}

/** A command's display in a notice: its first line, cut. */
function shortCommand(command: string): string {
  const line = command.trim().split("\n")[0] ?? ""
  const cut = line.length > NOTICE_COMMAND_CHARS ? `${line.slice(0, NOTICE_COMMAND_CHARS)}…` : line
  return cut + (command.trim().includes("\n") ? " …" : "")
}

/** `2m14s`, `850ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`

  const seconds = Math.round(ms / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, "0")}s`
  return `${rest}s`
}

/** How an ended command reads in a notice. */
export function endedLine(command: BackgroundCommandState): string {
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
export function runningLine(command: BackgroundCommandState, now: Date): string {
  const since = formatDuration(now.getTime() - new Date(command.startedAt).getTime())
  return `Background command ${command.id} (\`${shortCommand(command.command)}\`) is still running, started ${since} ago in an earlier turn. Output: ${command.outputPath}`
}

/**
 * Started detached from the held call's own output, in a process group of its own (`set -m`: no
 * `setsid` binary on macOS), its pid written first, then its exit code once it ended. Its exit is
 * the wrapper's. Arguments: output, pid and exit files, then the command.
 */
const START_SCRIPT = `mkdir -p -- "$(dirname -- "$1")" || exit 1
: > "$1" && rm -f -- "$2" "$3" || exit 1
set -m
bash -lc "$4" < /dev/null >> "$1" 2>&1 &
pid=$!
set +m
echo "$pid" > "$2.tmp" && mv -f -- "$2.tmp" "$2"
wait "$pid"
code=$?
echo "$code" > "$3"
exit "$code"`

/** Wait up to ten seconds for the pid file, then print it. */
const GROUP_SCRIPT = `i=0
while [ ! -s "$1" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
cat -- "$1"`

/**
 * Print the output's size, a newline, then what follows the bytes already read: its newest
 * bytes within the bound. Arguments: the file, the bytes read, the bound.
 */
const READ_SCRIPT = `[ -f "$1" ] || { echo 0; exit 0; }
size=$(wc -c < "$1" | tr -d ' ')
start=$2
[ "$start" -gt "$size" ] && start=$size
[ $((size - start)) -gt "$3" ] && start=$((size - $3))
echo "$size"
[ "$size" -gt "$start" ] && tail -c +$((start + 1)) -- "$1" | head -c $((size - start))
exit 0`
