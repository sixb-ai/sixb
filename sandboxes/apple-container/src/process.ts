import type { CommandResult } from "@sixb/core"

export interface AppleContainerCliResult extends CommandResult {
  readonly argv: readonly string[]
}

export interface RunAppleContainerCliOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly stdin?: Uint8Array
}

const DEFAULT_KILL_EXIT_CODE = 137
interface BunStdinSink {
  write(data: Uint8Array): unknown
  end(): unknown
}

/**
 * Bun.spawn wrapper for Apple Container CLI calls. It mirrors core exec.ts but also supports stdin,
 * which keeps writeFiles binary-safe without putting file contents into argv.
 */
export async function runAppleContainerCli(
  options: RunAppleContainerCliOptions
): Promise<AppleContainerCliResult> {
  const start = Date.now()
  const [head, ...rest] = options.argv
  if (!head) {
    return {
      argv: options.argv,
      exitCode: 1,
      stdout: "",
      stderr: "[Sandbox] empty argv",
      durationMs: 0,
    }
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([head, ...rest], {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return {
      argv: options.argv,
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    }
  }

  let timedOut = false
  let killed = false

  const kill = (): void => {
    if (!killed) {
      killed = true
      proc.kill("SIGKILL")
    }
  }

  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, options.timeoutMs)
      : undefined

  const onAbort = (): void => kill()
  options.signal?.addEventListener("abort", onAbort)
  if (options.signal?.aborted) {
    onAbort()
  }

  let stdout = ""
  let stderr = ""
  let exitCode = 0
  try {
    const [stdoutText, stderrText, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
      writeStdin(proc, options.stdin),
    ])
    stdout = stdoutText
    stderr = stderrText
    exitCode = typeof code === "number" ? code : DEFAULT_KILL_EXIT_CODE
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }

  if (killed && exitCode === 0) {
    exitCode = DEFAULT_KILL_EXIT_CODE
  }

  return {
    argv: options.argv,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    ...(timedOut ? { timedOut: true } : {}),
  }
}

async function writeStdin(
  proc: ReturnType<typeof Bun.spawn>,
  stdin: Uint8Array | undefined
): Promise<void> {
  if (stdin === undefined || !isBunStdinSink(proc.stdin)) {
    return
  }
  try {
    proc.stdin.write(stdin)
    proc.stdin.end()
  } catch {
    proc.kill("SIGKILL")
  }
}

function isBunStdinSink(value: unknown): value is BunStdinSink {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    "end" in value &&
    typeof value.write === "function" &&
    typeof value.end === "function"
  )
}
