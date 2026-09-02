import { readFile } from "node:fs/promises"

export interface CompletedCliProcess {
  readonly command: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

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
  const timeout = setTimeout(() => {
    timedOut = true
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
      throw processFailure(result, `timed out after ${timeoutMs}ms`)
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

function processFailure(result: CompletedCliProcess, reason: string): Error {
  return new Error(
    `[cli-process] Command ${reason}: ${result.command.join(" ")}\n` +
      `stdout:\n${result.stdout.slice(-2_000)}\n` +
      `stderr:\n${result.stderr.slice(-2_000)}`
  )
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
  readonly graceMs?: number
}): Promise<StartRoleResult> {
  // Long-running roles cold-start a full bun runtime; give that generous headroom
  // for slow/contended CI machines before declaring a hang.
  const timeoutMs = options.timeoutMs ?? 25_000
  const graceMs = options.graceMs ?? 0

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

  // Let any post-start polling (e.g. worker claim loops) run before stopping.
  if (graceMs > 0) {
    await Bun.sleep(graceMs)
  }

  proc.kill("SIGTERM")
  await proc.exited

  return { ready, logEntries: await readLogEntries(options.logPath) }
}
