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
  const timeoutMs = options.timeoutMs ?? 15_000

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
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs)

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
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

  proc.kill("SIGTERM")
  await proc.exited

  return {
    bannerSeen,
    stdout: stripAnsi(accumulated),
    logEntries: await readLogEntries(options.logPath),
  }
}
