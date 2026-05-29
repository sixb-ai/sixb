import { readFile } from "node:fs/promises"

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
      PARIO_CLI_TEST_LOG: options.logPath,
      PARIO_CLI_TEST_READY_LOG: options.logPath,
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
