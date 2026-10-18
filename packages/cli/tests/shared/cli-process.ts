import { readdirSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface CompletedCliProcess {
  readonly command: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Bound for a command that fails fast or finishes at once, under `bun test`'s default 5s test
 * timeout. These take well under a second; the bound sits below the runner's so this helper, not
 * the runner, kills a stuck child and reports where it was waiting.
 */
export const FAST_CLI_TIMEOUT_MS = 4_000

export async function runCliToCompletion(options: {
  readonly cmd: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdin?: string
  readonly timeoutMs?: number
}): Promise<CompletedCliProcess> {
  const command = [...options.cmd]
  const timeoutMs = options.timeoutMs ?? 10_000
  const proc = Bun.spawn({
    cmd: command,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (options.stdin !== undefined) {
    proc.stdin.write(options.stdin)
    proc.stdin.end()
  }

  let timedOut = false
  let waitState = ""
  const timeout = setTimeout(() => {
    timedOut = true
    // Read before the kill: once the child is gone, nothing says where it was stuck.
    waitState = threadWaitState(proc.pid)
    proc.kill("SIGKILL")
  }, timeoutMs)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const result = { command, exitCode, stdout, stderr }

    if (timedOut) {
      throw processFailure(result, `timed out after ${timeoutMs}ms`, waitState)
    }

    return result
  } finally {
    clearTimeout(timeout)
    if (proc.exitCode === null) {
      proc.kill("SIGKILL")
      await proc.exited
    }
  }
}

export function assertCliSucceeded(result: CompletedCliProcess): void {
  if (result.exitCode !== 0) {
    throw processFailure(result, `exited with code ${result.exitCode}`)
  }
}

function processFailure(result: CompletedCliProcess, reason: string, waitState?: string): Error {
  return new Error(
    `[cli-process] Command ${reason}: ${result.command.join(" ")}\n` +
      `stdout:\n${result.stdout.slice(-2_000)}\n` +
      `stderr:\n${result.stderr.slice(-2_000)}` +
      (waitState ? `\nthreads:\n${waitState}` : "")
  )
}

/**
 * Where each thread of a stuck child was waiting, from `/proc`, like `scripts/ci-guard.ts`. A
 * child that already printed its output and sits in `futex` hung on exit; one that printed nothing
 * hung starting up. Linux only: elsewhere it says so.
 */
function threadWaitState(pid: number): string {
  const taskDir = `/proc/${pid}/task`
  let tids: string[]
  try {
    tids = readdirSync(taskDir)
  } catch {
    return "  (unavailable: /proc is Linux-only)"
  }

  return tids
    .map((tid) => {
      const name = readProcFile(join(taskDir, tid, "comm"))
      // The state letter follows the parenthesised thread name in `stat`.
      const state = readProcFile(join(taskDir, tid, "stat"))
        .split(") ")
        .at(-1)
        ?.split(" ")[0]
      const wchan = readProcFile(join(taskDir, tid, "wchan"))
      return `  tid ${tid} [${state}] ${name} wchan=${wchan}`
    })
    .join("\n")
}

function readProcFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return "?"
  }
}

export async function readLogEntries(logPath: string): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(logPath, "utf-8").catch(() => "")
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export interface StartRoleResult {
  readonly ready: boolean
  readonly logEntries: Array<Record<string, unknown>>
}

/**
 * Boots a long-running role command and waits for its `role:ready` marker (written
 * by `runUntilSignal` once the role has finished starting), then stops it and
 * returns the operations log.
 *
 * Readiness is detected through a file marker rather than the role's stdout: Ink
 * suppresses rendered output when stdout is not a TTY (as under CI), so the
 * started banner never appears there. The marker is written synchronously before
 * the role idles, so it is observable even for roles that immediately exit when
 * the in-memory fixture providers leave nothing keeping the event loop alive.
 */
export async function startRoleUntilReadyThenStop(options: {
  readonly cmd: readonly string[]
  readonly cwd: string
  readonly logPath: string
  readonly timeoutMs?: number
  /** Runs against the started role before it is stopped, e.g. to request what it serves. */
  readonly whileReady?: () => Promise<void>
}): Promise<StartRoleResult> {
  // Long-running roles cold-start a full bun runtime; give that generous headroom
  // for slow/contended CI machines before declaring a hang.
  const timeoutMs = options.timeoutMs ?? 25_000

  const proc = Bun.spawn({
    cmd: [...options.cmd],
    cwd: options.cwd,
    env: {
      ...process.env,
      SIXB_CLI_TEST_LOG: options.logPath,
      SIXB_CLI_TEST_READY_LOG: options.logPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  let ready = false
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await readLogEntries(options.logPath)
    if (entries.some((entry) => entry.type === "role:ready")) {
      ready = true
      break
    }
    if (proc.exitCode !== null && proc.exitCode !== undefined) {
      // Process exited before signalling readiness. Re-check the log once (the
      // marker is written synchronously, so a clean early exit still records it).
      const finalEntries = await readLogEntries(options.logPath)
      ready = finalEntries.some((entry) => entry.type === "role:ready")
      break
    }
    await Bun.sleep(50)
  }

  if (!ready) {
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    proc.kill("SIGKILL")
    await proc.exited
    throw new Error(
      `[cli-process] Role command never signalled readiness within ${timeoutMs}ms.\n` +
        `cmd: ${options.cmd.join(" ")}\n` +
        `stdout:\n${stdout.slice(-1000)}\n` +
        `stderr:\n${stderr.slice(-1000)}`
    )
  }

  try {
    await options.whileReady?.()
  } finally {
    proc.kill("SIGTERM")
    await proc.exited
  }

  return { ready, logEntries: await readLogEntries(options.logPath) }
}
