import { randomBytes } from "node:crypto"
import { posix } from "node:path"
import { AgentToolPublicError, type CommandResult, type Sandbox } from "@sixb/core"
import { waitForAbort } from "./abort"
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

export type BackgroundCommandStatus = "running" | "exited" | "stopped"

/** A background command as its tools report it, and as a chat can show it. */
export interface BackgroundCommandState {
  /** `bg_<hex>`: the id `bash_output` and `bash_stop` take, never the same in two runs. */
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
  /** Settles once its process group is known, or it ended without one. */
  readonly started: Promise<void>
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

  /** Whether it ever started one: their files are then worth keeping for a later turn. */
  get hasCommands(): boolean {
    return this.#commands.size > 0
  }

  /** Whether one of them runs now. */
  get running(): boolean {
    return [...this.#commands.values()].some((entry) => entry.status === "running")
  }

  /**
   * Start `command` in the background and return once it runs, its output going to its file. One
   * the sandbox could not start, as in a directory that does not exist, throws what it said. A
   * `signal` that aborts before then stops it.
   */
  async start(input: {
    readonly handle: AgentSandboxHandle
    readonly command: string
    readonly cwd?: string
    readonly signal?: AbortSignal
  }): Promise<BackgroundCommandState> {
    const running = [...this.#commands.values()].filter((entry) => entry.status === "running")
    if (running.length >= MAX_RUNNING) {
      throw new AgentToolPublicError(
        `[SixbAgent] ${MAX_RUNNING} background commands are running already: stop one with bash_stop first.`
      )
    }

    const { handle } = input
    const { sandbox } = handle
    const id = this.#newId()
    const directory = contextPath(handle, BACKGROUND_DIRECTORY)
    const paths = {
      output: posix.join(directory, `${id}.log`),
      pid: posix.join(directory, `${id}.pid`),
      exit: posix.join(directory, `${id}.exit`),
    }
    // The pid file names the start that wrote it: a file an earlier start left is never read.
    const nonce = randomBytes(8).toString("hex")
    const abort = new AbortController()

    const held = sandbox.runCommand(
      "bash",
      [
        "-c",
        START_SCRIPT,
        "sixb-background",
        paths.output,
        paths.pid,
        paths.exit,
        nonce,
        input.command,
      ],
      {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(handle.env === undefined ? {} : { env: handle.env }),
        timeout: HELD_TIMEOUT_MS,
        signal: abort.signal,
      }
    )
    const ended = held.then(
      (result) => this.#end(entry, result),
      (error: unknown) => this.#end(entry, undefined, error)
    )
    // Its group is known once the wrapper wrote it, which it does first: until then nothing could
    // signal it, so a stop and `start` itself wait for it, or for its end without one.
    const started = Promise.race([
      readGroup(sandbox, paths.pid, nonce, handle.env).then(
        (group) => {
          if (group !== undefined) entry.group = group
        },
        () => {}
      ),
      ended,
    ])
    const entry: BackgroundCommand = {
      id,
      command: input.command,
      startedAt: new Date(),
      paths,
      sandbox,
      abort,
      started,
      ended,
      status: "running",
      readBytes: 0,
      reported: false,
    }
    this.#commands.set(id, entry)

    try {
      await waitForAbort(started, input.signal)
    } catch (error) {
      await this.stop(id)
      throw error
    }

    if (entry.failure !== undefined) {
      this.#commands.delete(id)
      throw new AgentToolPublicError(`[SixbAgent] The command could not start: ${entry.failure}`)
    }
    if (entry.status !== "running") entry.reported = true
    return state(entry)
  }

  /** Whether it knows a command by this id. */
  has(id: string): boolean {
    return this.#commands.has(id)
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

  #newId(): string {
    for (;;) {
      const id = `bg_${randomBytes(3).toString("hex")}`
      if (!this.#commands.has(id)) return id
    }
  }

  #find(id: string): BackgroundCommand {
    const entry = this.#commands.get(id)
    if (!entry) {
      const known = [...this.#commands.keys()]
      throw new AgentToolPublicError(
        `[SixbAgent] No background command '${id}'${known.length > 0 ? `: the known ones are ${known.join(", ")}` : ""}. One an earlier run started ended with that run, or with the sixb that ran it.`
      )
    }
    return entry
  }

  async #stop(entry: BackgroundCommand): Promise<void> {
    // A stop asked for as it starts waits for its group: the held call's abort alone would stop
    // the wrapper and leave the group it started running.
    await entry.started

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

  #end(entry: BackgroundCommand, result: CommandResult | undefined, error?: unknown): void {
    entry.endedAt = new Date()
    if (!result) {
      // Its sandbox went away under it, or never ran it.
      entry.status = "stopped"
      console.warn(`[SixbAgent] Background command ${entry.id} ended with its sandbox:`, error)
      return
    }

    entry.exitCode = result.exitCode
    // Stopped when a signal of its stop ended it, as its exit code says; one that exited by itself
    // meanwhile, or caught the signal and exited, exited.
    entry.status =
      entry.stopping !== undefined && (result.exitCode > 128 || entry.abort.signal.aborted)
        ? "stopped"
        : "exited"
    // The wrapper writes nothing of its own unless it, or the sandbox, could not run it.
    if (result.stderr.trim() && entry.group === undefined) entry.failure = result.stderr.trim()

    // Past its bound, the held call's abort stopped the wrapper, not the group it started.
    if (result.timedOut) void signalGroup(entry, "KILL")
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

/** The process group the wrapper wrote with this start's nonce, waited for in the sandbox. */
async function readGroup(
  sandbox: Sandbox,
  path: string,
  nonce: string,
  env: Readonly<Record<string, string>> | undefined
): Promise<number | undefined> {
  const result = await sandbox.runCommand(
    "bash",
    ["-c", GROUP_SCRIPT, "sixb-background", path, nonce],
    { ...(env === undefined ? {} : { env }), timeout: CONTROL_TIMEOUT_MS }
  )
  const group = Number(result.stdout.trim())
  return result.exitCode === 0 && Number.isSafeInteger(group) && group > 1 ? group : undefined
}

/**
 * Signal its process group from inside the sandbox it runs in. False when nothing received it:
 * no group known, or one this sandbox cannot see, as a command run under a PID namespace of its
 * own (bwrap): its stop is then the held call's abort, at once.
 */
async function signalGroup(entry: BackgroundCommand, signal: "TERM" | "KILL"): Promise<boolean> {
  if (entry.group === undefined) return false

  try {
    const result = await entry.sandbox.runCommand(
      "bash",
      ["-c", SIGNAL_SCRIPT, "sixb-background", signal, String(entry.group)],
      { timeout: CONTROL_TIMEOUT_MS }
    )
    return result.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Stop the commands a `sixb` that ended without stopping them left running: one killed, or that
 * crashed. Their pid files are all that is left of them. Each group still running its command
 * gets SIGTERM, then SIGKILL after the grace period `bash_stop` gives, in one call.
 */
export async function stopLeftRunning(
  sandbox: Sandbox,
  pidFiles: readonly string[],
  signal: AbortSignal
): Promise<void> {
  const result = await sandbox.runCommand(
    "bash",
    ["-c", REAP_SCRIPT, "sixb-background-reap", String(STOP_GRACE_MS / 50), ...pidFiles],
    { timeout: CONTROL_TIMEOUT_MS, signal }
  )
  if (result.exitCode !== 0) {
    throw new Error(`[SixbAgent] ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }
}

/** Signal a process group. Arguments: the signal, the group. */
const SIGNAL_SCRIPT = 'kill -s "$1" -- "-$2" 2>/dev/null'

/**
 * Started detached from the held call's own output, in a process group of its own (`set -m`: no
 * `setsid` binary on macOS), its pid written first with the start's nonce, then its exit code once
 * it ended. Its exit is the wrapper's. Arguments: output, pid and exit files, nonce, command.
 */
const START_SCRIPT = `mkdir -p -- "$(dirname -- "$1")" || exit 1
: > "$1" && rm -f -- "$3" || exit 1
set -m
bash -lc "$5" < /dev/null >> "$1" 2>&1 &
pid=$!
set +m
echo "$4 $pid" > "$2.tmp" && mv -f -- "$2.tmp" "$2"
wait "$pid"
code=$?
echo "$code" > "$3"
exit "$code"`

/** Wait up to ten seconds for the pid file this start's nonce names, then print the pid. */
const GROUP_SCRIPT = `i=0
while [ "$i" -lt 200 ]; do
  { read -r nonce pid < "$1"; } 2>/dev/null && [ "$nonce" = "$2" ] && { echo "$pid"; exit 0; }
  sleep 0.05
  i=$((i + 1))
done
exit 1`

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

/**
 * SIGTERM to each group a pid file names that is still its command's, SIGKILL to those left after
 * the grace period. Arguments: the grace period in 50 ms polls, then the pid files.
 *
 * A group is its command's only while one of its processes holds the command's output file, which
 * the start opened for every process of it: a group id reused since, by anything else, holds no
 * such file, and is never signalled. The start leaves nothing else to check on macOS: a command
 * line keeps nothing of ours once bash runs the command in its own place, and `ps` shows no
 * environment of Apple's own binaries, bash and sleep among them. Linux lists open files in
 * `/proc`; macOS through `lsof`.
 */
const REAP_SCRIPT = `signal() { ${SIGNAL_SCRIPT}; }
holds() {
  if [ -d /proc/self/fd ]; then
    for fd in "/proc/$1/fd/"*; do
      [ "$(readlink "$fd" 2>/dev/null)" = "$2" ] && return 0
    done
    return 1
  fi
  lsof -a -p "$1" -- "$2" > /dev/null 2>&1
}
ours() {
  case "$1" in ''|*[!0-9]*|0|1) return 1 ;; esac
  for pid in $(ps -A -o pid= -o pgid= | awk -v group="$1" '$2 == group { print $1 }'); do
    holds "$pid" "$2" && return 0
  done
  return 1
}
grace=$1
shift
termed=""
for file in "$@"; do
  { read -r _ group < "$file"; } 2>/dev/null || continue
  ours "$group" "\${file%.pid}.log" && signal TERM "$group" && termed="$termed $group"
done
i=0
while [ -n "$termed" ] && [ "$i" -lt "$grace" ]; do
  left=""
  for group in $termed; do
    kill -0 -- "-$group" 2>/dev/null && left="$left $group"
  done
  termed=$left
  [ -n "$termed" ] && sleep 0.05
  i=$((i + 1))
done
for file in "$@"; do
  { read -r _ group < "$file"; } 2>/dev/null || continue
  case " $termed " in
    *" $group "*) ours "$group" "\${file%.pid}.log" && signal KILL "$group" ;;
  esac
done
exit 0`
