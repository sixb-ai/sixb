import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface TailwindCssCompilerOptions {
  /** Tailwind source stylesheet. */
  inputPath: string
  /** Compiled CSS output path. */
  outputPath: string
  /**
   * Working directory for the Tailwind CLI. Tailwind v4's automatic source
   * detection scans from here, so keep it scoped to the directory that owns the
   * styles (e.g. `app/`) — never a repo root that may contain `vendor/` or
   * `node_modules/` siblings.
   */
  cwd?: string
  /**
   * Directory whose dependency tree is used to resolve `@tailwindcss/cli`.
   * Defaults to `cwd`. Pass the project root so the project's own Tailwind
   * version wins.
   */
  resolveFrom?: string
  /** Prefix for error messages, e.g. `[SixbAtlas]`. */
  label?: string
  /** Minify the compiled CSS. Off by default; bundlers usually minify later. */
  minify?: boolean
  /** Debounce for `schedule()` rebuilds, in milliseconds. */
  debounceMs?: number
  /**
   * Upper bound on one Tailwind build, in milliseconds. Defaults to 60s.
   *
   * A bound on a hang, not a performance budget: a wedged CLI otherwise held `sixb dev` open
   * forever, and `stop()` waited on it.
   */
  timeoutMs?: number
  /** Called when a `schedule()`d rebuild fails. Defaults to `console.error`. */
  onError?: (error: Error) => void
}

export interface TailwindCssCompiler {
  /**
   * Compiles the stylesheet. Builds are serialized: a call made while another
   * build is running starts a fresh build after it, so the output always
   * reflects the sources as of the call. Throws with a labeled, actionable
   * error when the CLI is missing or compilation fails.
   */
  compile(): Promise<void>
  /**
   * Debounced `compile()` for watch flows. Coalesces bursts of file events;
   * errors go to `onError` instead of throwing.
   */
  schedule(): void
  /** Cancels pending rebuilds and waits for any in-flight build to settle. */
  stop(): Promise<void>
}

/**
 * Resolves the Tailwind v4 CLI entry point from a directory's dependency tree.
 * Returns null when `@tailwindcss/cli` is not installed there.
 */
export function resolveTailwindCliEntry(resolveFrom: string): string | null {
  try {
    const packageJsonPath = Bun.resolveSync("@tailwindcss/cli/package.json", resolveFrom)
    return join(dirname(packageJsonPath), "dist", "index.mjs")
  } catch {
    return null
  }
}

/**
 * Shared Tailwind v4 CSS build pipeline used by the built-in UI (Atlas) and
 * custom apps. Owns CLI resolution, source-detection scoping,
 * debounced/queued rebuilds, error formatting, and watch lifecycle cleanup.
 */
export function createTailwindCssCompiler(
  options: TailwindCssCompilerOptions
): TailwindCssCompiler {
  const cwd = options.cwd ?? dirname(options.inputPath)
  const resolveFrom = options.resolveFrom ?? cwd
  const label = options.label ?? "[SixbTailwind]"
  const debounceMs = options.debounceMs ?? 50
  const timeoutMs = options.timeoutMs ?? 60_000
  const onError = options.onError ?? ((error: Error) => console.error(`${label} ${error.message}`))

  let chain: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let activeProcess: { kill: (signal?: number | NodeJS.Signals) => void } | null = null

  async function runCompile(): Promise<void> {
    // `compile()` queues this behind the current chain, so a `stop()` can land before the
    // child is ever spawned. Without this the build started anyway and there was nothing
    // for `stop()` to kill, so shutdown waited out the full timeout.
    if (stopped) return

    const cliEntry = resolveTailwindCliEntry(resolveFrom)
    if (!cliEntry) {
      throw new Error(
        `${label} Tailwind CSS build requires '@tailwindcss/cli'. Install it with: bun add tailwindcss @tailwindcss/cli`
      )
    }

    await mkdir(dirname(options.outputPath), { recursive: true })
    // The only await before the spawn, so the only other window a `stop()` can land in.
    if (stopped) return

    const args = [process.execPath, cliEntry, "-i", options.inputPath, "-o", options.outputPath]
    if (options.minify) {
      args.push("--minify")
    }

    const proc = Bun.spawn(args, {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
    })
    activeProcess = proc

    // Start draining stderr while the child runs rather than after it exits. Bun buffers
    // this pipe today, so reading afterwards does not block the child — measured, not
    // assumed — but that is Bun's choice and not something this code should depend on. The
    // catch keeps a stream torn down by `kill()` from surfacing as an unhandled rejection.
    const stderr = new Response(proc.stderr).text().catch(() => "")

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMs)
    })

    try {
      const outcome = await Promise.race([proc.exited, timedOut])

      // `stop()` kills the child on purpose. Reporting that as a build failure would put
      // an error in the log for every shutdown that happened to catch a rebuild.
      if (stopped) return

      if (outcome === "timeout") {
        proc.kill("SIGKILL")
        await proc.exited
        throw new Error(
          `${label} Tailwind CSS build did not finish within ${timeoutMs}ms and was killed. ` +
            `Check ${options.inputPath} and the sources Tailwind scans from ${cwd}.`
        )
      }

      if (outcome !== 0) {
        throw new Error(`${label} Tailwind CSS build failed: ${(await stderr).trim()}`)
      }
    } finally {
      clearTimeout(timeout)
      activeProcess = null
    }
  }

  function compile(): Promise<void> {
    stopped = false
    const build = chain.then(() => runCompile())
    // The chain itself swallows failures so one bad build doesn't poison every
    // later compile; callers still observe their own build's error.
    chain = build.then(
      () => {},
      () => {}
    )
    return build
  }

  return {
    compile,

    schedule() {
      if (stopped) return
      if (timer) {
        clearTimeout(timer)
      }

      timer = setTimeout(() => {
        timer = null
        compile().catch((error) => {
          onError(error instanceof Error ? error : new Error(String(error)))
        })
      }, debounceMs)
    },

    async stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // Kill rather than wait. A build in flight would otherwise hold shutdown for up to
      // the whole timeout, and the output it is writing is about to be discarded anyway.
      activeProcess?.kill("SIGKILL")
      await chain
    },
  }
}
