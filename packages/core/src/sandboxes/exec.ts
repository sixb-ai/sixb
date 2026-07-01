import type { CommandResult } from "./sandbox"

export interface ExecOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const DEFAULT_KILL_EXIT_CODE = 137

/**
 * Spawn a child process and gather its {@link CommandResult}. Wraps Bun.spawn with timeout and
 * AbortSignal handling, and never throws. Command-agnostic: the wrapper makes no assumptions about
 * what it spawns, so sandbox providers share it. On timeout/abort it SIGKILLs the spawned process;
 * any provider whose spawned process merely fronts a longer-lived resource (e.g. a VM) is
 * responsible for reaping that resource in its own stop()/destroy().
 */
export async function exec(options: ExecOptions): Promise<CommandResult> {
  const start = Date.now()

  const [head, ...rest] = options.argv
  if (!head) {
    return {
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
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    }
  }

  let timedOut = false
  let killed = false

  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          killed = true
          proc.kill("SIGKILL")
        }, options.timeoutMs)
      : undefined

  const onAbort = (): void => {
    if (!killed) {
      killed = true
      proc.kill("SIGKILL")
    }
  }
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
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    ...(timedOut ? { timedOut: true } : {}),
  }
}
