import { readFile } from "node:fs/promises"

export function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ")
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
  readonly bannerSeen: boolean
  readonly stdout: string
  readonly logEntries: Array<Record<string, unknown>>
}

/**
 * Boots a long-running role command, reads its stdout until the given banner
 * appears (every started view ends with "Press Ctrl+C to stop"), then stops it
 * and returns the captured output plus the operations log written by the fixture.
 *
 * Waiting on the started banner — rather than a side-effect like a storage
 * migration — keeps these tests valid even when a role does no startup work.
 */
export async function startRoleUntilBannerThenStop(options: {
  readonly cmd: readonly string[]
  readonly cwd: string
  readonly logPath: string
  readonly banner?: string
  readonly timeoutMs?: number
}): Promise<StartRoleResult> {
  const banner = options.banner ?? "Ctrl+C to stop"
  // Long-running roles cold-start a full bun runtime; give that generous headroom
  // for slow/contended CI machines before declaring a hang.
  const timeoutMs = options.timeoutMs ?? 25_000

  const proc = Bun.spawn({
    cmd: [...options.cmd],
    cwd: options.cwd,
    env: { ...process.env, PARIO_CLI_TEST_LOG: options.logPath },
    stdout: "pipe",
    stderr: "pipe",
  })

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let accumulated = ""
  let bannerSeen = false
  let exitedEarly = false
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs)

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        exitedEarly = true
        break
      }
      accumulated += decoder.decode(value, { stream: true })
      if (stripAnsi(accumulated).includes(banner)) {
        bannerSeen = true
        break
      }
    }
  } finally {
    clearTimeout(killTimer)
    reader.releaseLock()
  }

  if (!bannerSeen) {
    // The role exited (or was killed at timeout) before reaching its started
    // banner. Surface stderr so the failure is diagnosable instead of a bare
    // "bannerSeen === false".
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    throw new Error(
      `[cli-process] Role command did not reach its started banner ` +
        `(exitedEarly=${exitedEarly}, exitCode=${exitCode}).\n` +
        `cmd: ${options.cmd.join(" ")}\n` +
        `stdout:\n${stripAnsi(accumulated).slice(-1000)}\n` +
        `stderr:\n${stderr.slice(-1000)}`
    )
  }

  proc.kill("SIGTERM")
  await proc.exited

  return {
    bannerSeen,
    stdout: stripAnsi(accumulated),
    logEntries: await readLogEntries(options.logPath),
  }
}
