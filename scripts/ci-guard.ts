/**
 * Runs a command and fails it — loudly, and with a diagnosis — when it stops making progress.
 *
 * A job that dies at its own `timeout-minutes` tells you nothing: the log ends mid-stream, the
 * conclusion reads "cancelled" rather than "failure", and the process that was stuck is gone
 * before anyone can look at it. That is how a wedged bundler cost this repo five 15-minute CI
 * runs before the failing test was even named.
 *
 * So the bound moves off the job and onto *output*. Test runners print as they go, which makes a
 * silence the earliest honest signal that something stopped. On a stall this prints the last line
 * it saw, the last test file that opened, the process tree, and — on Linux — the kernel wait
 * channel of every thread, which is what separates a lock deadlock (`futex`) from a network wait
 * from an honestly slow build. Then it kills the tree and exits non-zero.
 *
 * Usage:
 *   bun scripts/ci-guard.ts --stall 60 [--max 420] bun test
 */

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { join } from "node:path"

/** Conventional timeout exit code, so a stall is distinguishable from any code the command returns. */
const STALL_EXIT_CODE = 124

interface GuardOptions {
  readonly stallSeconds: number
  readonly maxSeconds: number | null
  readonly command: readonly string[]
}

/** Output lines kept for the stall report. Enough to show which file opened last and what it printed. */
const TAIL_LINES = 25

/** Matches a test file path in runner output, with or without an Actions `::group::` prefix. */
const TEST_FILE_PATTERN = /([\w./@-]+\.(?:test|e2e|spec)\.[jt]sx?):?\s*$/

/**
 * Grace between SIGTERM and SIGKILL. Short on purpose: a process that is genuinely wedged will not
 * answer SIGTERM at all, so a long grace only delays the failure it already earned.
 */
const TERM_GRACE_MS = 500

/** Exit code for a usage error, distinct from both a stall and any code the command may return. */
const USAGE_EXIT_CODE = 2

/** How often progress is checked. Also the worst-case lateness of a stall report. */
const POLL_MS = 1000

/** A diagnostic must never become the reason the guard cannot reach process cleanup. */
const PROCESS_TABLE_TIMEOUT_MS = 2000

/** Signals relayed only after the guarded process group has been stopped. */
const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = USAGE_EXIT_CODE
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv)
  const started = performance.now()

  const child = Bun.spawn([...options.command], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    // A process group gives cleanup a reliable fallback when a restricted sandbox blocks `ps -A`.
    // Pipes still keep the child attached; `detached` only establishes the group on POSIX.
    detached: process.platform !== "win32",
  })

  let stopChildPromise: Promise<void> | null = null
  const stopChild = (): Promise<void> => {
    stopChildPromise ??= killTree(child.pid)
    return stopChildPromise
  }

  let relayingSignal = false
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  function removeSignalHandlers(): void {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
  }
  for (const signal of TERMINATION_SIGNALS) {
    const handler = (): void => {
      if (relayingSignal) return
      relayingSignal = true
      void stopChild().finally(() => {
        removeSignalHandlers()
        // Preserve the conventional signal exit status after giving descendants a chance to stop.
        process.kill(process.pid, signal)
      })
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }

  const tail: string[] = []
  let lastTestFile: string | null = null
  let lastOutputAt = performance.now()

  function observe(chunk: string): void {
    lastOutputAt = performance.now()
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue
      tail.push(line)
      if (tail.length > TAIL_LINES) tail.shift()
      const match = line.match(TEST_FILE_PATTERN)
      if (match) lastTestFile = match[1]
    }
  }

  // Both pipes are drained concurrently and forwarded unchanged. A pipe left unread is its own
  // hang: the child blocks writing into a full buffer while the parent waits for an exit that the
  // blocked write is preventing.
  const forwarding = Promise.all([
    forward(child.stdout, Bun.stdout, observe),
    forward(child.stderr, Bun.stderr, observe),
  ])
  // The stall path does not await forwarding: if signaling is denied, waiting for pipe EOF would
  // recreate the hang this guard exists to bound. Mark a broken downstream pipe as handled here.
  void forwarding.catch(() => {})

  // The stall check runs on an interval that is cleared as soon as the race settles. A polling
  // loop built from awaited sleeps would instead leave a live timer behind and keep this process
  // alive after the command finished — the guard's own version of the bug it exists to catch.
  let stallTimer: ReturnType<typeof setInterval> | undefined
  const stalled = new Promise<{ kind: "stalled"; reason: string }>((resolve) => {
    stallTimer = setInterval(() => {
      const silent = (performance.now() - lastOutputAt) / 1000
      if (silent >= options.stallSeconds) {
        resolve({
          kind: "stalled",
          reason: `no output for ${silent.toFixed(0)}s (limit ${options.stallSeconds}s)`,
        })
        return
      }
      const elapsed = (performance.now() - started) / 1000
      if (options.maxSeconds !== null && elapsed >= options.maxSeconds) {
        resolve({
          kind: "stalled",
          reason: `ran for ${elapsed.toFixed(0)}s (limit ${options.maxSeconds}s)`,
        })
      }
    }, POLL_MS)
  })

  try {
    let verdict: { kind: "exited"; code: number } | { kind: "stalled"; reason: string }
    try {
      verdict = await Promise.race([
        child.exited.then((code) => ({ kind: "exited" as const, code })),
        stalled,
      ])
    } finally {
      clearInterval(stallTimer)
    }

    if (verdict.kind === "exited") {
      await forwarding
      return verdict.code
    }

    // Snapshot the process state before killing anything, but stop the tree before writing the
    // report: a closed parent pipe must not throw or SIGPIPE before cleanup gets its chance.
    const report = await diagnose(child.pid, {
      reason: verdict.reason,
      elapsedSeconds: (performance.now() - started) / 1000,
      silentSeconds: (performance.now() - lastOutputAt) / 1000,
      lastTestFile,
      tail,
    })
    await stopChild()
    process.stderr.write(report)
    return STALL_EXIT_CODE
  } catch (error) {
    await stopChild()
    throw error
  } finally {
    removeSignalHandlers()
  }
}

async function forward(
  source: ReadableStream<Uint8Array>,
  sink: Bun.BunFile,
  observe: (chunk: string) => void
): Promise<void> {
  const writer = sink.writer()
  const decoder = new TextDecoder()
  const reader = source.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      writer.write(value)
      writer.flush()
      observe(decoder.decode(value, { stream: true }))
    }
  } finally {
    writer.flush()
    reader.releaseLock()
  }
}

interface StallContext {
  readonly reason: string
  readonly elapsedSeconds: number
  readonly silentSeconds: number
  readonly lastTestFile: string | null
  readonly tail: readonly string[]
}

async function diagnose(pid: number, context: StallContext): Promise<string> {
  const processes = await processTable()
  const tree = descendants(processes, pid)
  const lines: string[] = []

  // An Actions `error` annotation surfaces this at the top of the run instead of line 4000 of a log.
  lines.push(
    `::error title=CI guard: stalled::${context.reason}${
      context.lastTestFile ? ` — last test file: ${context.lastTestFile}` : ""
    }`
  )
  lines.push("")
  lines.push("=".repeat(78))
  lines.push(`CI guard: the command stopped producing output and was killed.`)
  lines.push("=".repeat(78))
  lines.push(`  reason:          ${context.reason}`)
  lines.push(`  total elapsed:   ${context.elapsedSeconds.toFixed(0)}s`)
  lines.push(`  silent for:      ${context.silentSeconds.toFixed(0)}s`)
  lines.push(`  last test file:  ${context.lastTestFile ?? "(none seen)"}`)
  lines.push("")
  lines.push(`-- last ${context.tail.length} output lines ------------------------------------`)
  for (const line of context.tail) lines.push(`  ${line}`)
  lines.push("")
  lines.push("-- process tree ------------------------------------------------")
  if (tree.length === 0) {
    lines.push("  (no surviving processes — the child exited between the check and this dump)")
  }
  for (const entry of tree) {
    lines.push(
      `  ${entry.pid} (parent ${entry.ppid}) [${entry.state}] cpu=${entry.cpu}% ${entry.command}`
    )
  }
  lines.push("")
  lines.push("-- thread wait state -------------------------------------------")
  lines.push(
    "   'futex'/'futex_wait' on every thread means a lock deadlock; a socket wait means it is"
  )
  lines.push("   blocked on the network; 'running' means it is genuinely working, just slowly.")
  let sawThreads = false
  for (const entry of tree) {
    const threads = threadStates(entry.pid)
    if (threads.length === 0) continue
    sawThreads = true
    lines.push(`  pid ${entry.pid}:`)
    for (const thread of threads) {
      lines.push(`    tid ${thread.tid} [${thread.state}] ${thread.name} wchan=${thread.wchan}`)
    }
    const sockets = socketCount(entry.pid)
    if (sockets !== null) lines.push(`    open fds: ${sockets.total} (${sockets.sockets} sockets)`)
  }
  if (!sawThreads) {
    lines.push("  (unavailable: /proc is Linux-only, so this section is empty on macOS runners)")
  }
  lines.push("=".repeat(78))
  lines.push("")

  return `${lines.join("\n")}\n`
}

interface ProcessEntry {
  readonly pid: number
  readonly ppid: number
  readonly state: string
  readonly cpu: string
  readonly command: string
}

/** `ps -A` with an explicit format: the one process listing that behaves the same on Linux and macOS. */
async function processTable(): Promise<ProcessEntry[]> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    proc = Bun.spawn(["ps", "-Ao", "pid=,ppid=,stat=,pcpu=,args="], {
      stdout: "pipe",
      stderr: "ignore",
    })
  } catch {
    return []
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const output = await new Promise<string | null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROCESS_TABLE_TIMEOUT_MS)
    void new Response(proc.stdout).text().then(resolve, () => resolve(null))
  }).finally(() => clearTimeout(timer))

  if (output === null) {
    try {
      proc.kill()
    } catch {
      // The process may already have failed under the same sandbox restriction as `ps -A`.
    }
    return []
  }

  const entries: ProcessEntry[] = []
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/)
    if (!match) continue
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      state: match[3],
      cpu: match[4],
      command: match[5],
    })
  }
  return entries
}

/** The stalled process and everything under it, parents before children. */
function descendants(all: readonly ProcessEntry[], rootPid: number): ProcessEntry[] {
  const byParent = new Map<number, ProcessEntry[]>()
  for (const entry of all) {
    byParent.set(entry.ppid, [...(byParent.get(entry.ppid) ?? []), entry])
  }

  const found: ProcessEntry[] = []
  const queue = all.filter((entry) => entry.pid === rootPid)
  while (queue.length > 0) {
    const entry = queue.shift()
    if (!entry) break
    found.push(entry)
    queue.push(...(byParent.get(entry.pid) ?? []))
  }
  return found
}

interface ThreadState {
  readonly tid: string
  readonly name: string
  readonly state: string
  readonly wchan: string
}

/**
 * Per-thread kernel state from `/proc`. This is the section that actually identifies a deadlock:
 * a process whose every thread sits in `futex` is waiting on a lock nobody will release, which no
 * amount of extra timeout would have fixed.
 */
function threadStates(pid: number): ThreadState[] {
  const taskDir = `/proc/${pid}/task`
  if (!existsSync(taskDir)) return []

  const states: ThreadState[] = []
  let tids: string[]
  try {
    tids = readdirSync(taskDir)
  } catch {
    return []
  }

  for (const tid of tids) {
    states.push({
      tid,
      name: read(join(taskDir, tid, "comm")) ?? "?",
      state:
        read(join(taskDir, tid, "stat"))
          ?.split(") ")
          .at(-1)
          ?.split(" ")[0] ?? "?",
      wchan: read(join(taskDir, tid, "wchan")) ?? "?",
    })
  }
  return states
}

/** How many of the process's descriptors are sockets — a blocked network read shows up here. */
function socketCount(pid: number): { total: number; sockets: number } | null {
  const fdDir = `/proc/${pid}/fd`
  if (!existsSync(fdDir)) return null

  try {
    const fds = readdirSync(fdDir)
    let sockets = 0
    for (const fd of fds) {
      // A socket descriptor's link target is `socket:[inode]`; a file's is a path.
      if (readLink(join(fdDir, fd))?.startsWith("socket:")) sockets++
    }
    return { total: fds.length, sockets }
  } catch {
    return null
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return null
  }
}

/**
 * The guarded command owns a POSIX process group, so cleanup does not depend on `ps -A` being
 * available. The discovered tree remains a second line of defence for descendants that create
 * their own groups. Children are signaled before the root to avoid reparenting them mid-cleanup.
 */
async function killTree(rootPid: number): Promise<void> {
  // Start discovery before signaling the root, while parent links still describe the whole tree.
  const processes = processTable()

  // The process group is the path that must not wait on `ps`: command runners commonly allow only
  // a short grace before escalating their own SIGTERM to SIGKILL.
  signalProcessGroup(rootPid, "SIGTERM")
  signalProcesses([rootPid], "SIGTERM")
  const forceGroup = Bun.sleep(TERM_GRACE_MS).then(() => {
    signalProcessGroup(rootPid, "SIGKILL")
    signalProcesses([rootPid], "SIGKILL")
  })

  const tree = descendants(await processes, rootPid)
  const individualPids = [...new Set([...tree].reverse().map((entry) => entry.pid))]
  signalProcesses(individualPids, "SIGTERM")
  await forceGroup
  signalProcesses(individualPids, "SIGKILL")
}

function signalProcessGroup(rootPid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") return
  try {
    process.kill(-rootPid, signal)
  } catch {
    // The group may already be gone, or a restricted host may only allow individual signals.
  }
}

function signalProcesses(pids: readonly number[], signal: "SIGTERM" | "SIGKILL"): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone or not visible to this process sandbox.
    }
  }
}

/**
 * Flags first, then the command — the first argument that is not a known flag begins it.
 *
 * A bare `--` is accepted and ignored rather than required as the separator: `bun script.ts -- cmd`
 * strips it before the script ever sees it, so depending on it would make the invocation in
 * `ci.yml` read correctly and behave differently.
 */
function parseOptions(argv: readonly string[]): GuardOptions {
  let stallSeconds: number | null = null
  let maxSeconds: number | null = null
  let index = 0

  for (; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--") continue
    if (arg === "--stall") {
      stallSeconds = requireSeconds(argv[++index], "--stall")
      continue
    }
    if (arg === "--max") {
      maxSeconds = requireSeconds(argv[++index], "--max")
      continue
    }
    if (arg.startsWith("--")) {
      throw new Error(`[CIGuard] Unknown flag '${arg}'.`)
    }
    break
  }

  const command = argv.slice(index)

  if (stallSeconds === null) {
    throw new Error("[CIGuard] --stall <seconds> is required.")
  }
  if (command.length === 0) {
    throw new Error("[CIGuard] Expected a command to run after the flags.")
  }

  return { stallSeconds, maxSeconds, command }
}

function requireSeconds(value: string | undefined, flag: string): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`[CIGuard] ${flag} needs a positive number of seconds, got '${value}'.`)
  }
  return seconds
}
