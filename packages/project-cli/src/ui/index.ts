import type { CliHelp } from "../lib/command-line"
import { errorMessage, errorRemediation } from "../lib/errors"
import { commandHelpView, errorView, helpView, versionView } from "./screens"
import { glyph, SPINNER_FRAMES, tone } from "./theme"

export * from "./deploy-screens"
export * from "./screens"

/**
 * Writes a finished screen. Screens are plain strings, so nothing here loads a renderer: the
 * live screens (`sixb dev`, a deploy in progress, prompts) live in `./live` and load on demand.
 */
export async function renderStatic(view: string): Promise<void> {
  process.stdout.write(view)
}

/**
 * Renders a caught failure the one way the CLI renders failures, so a remediation carried on
 * the error reaches the terminal without each caller remembering to pass it through.
 */
export async function renderCliError(
  error: unknown,
  options: { readonly title?: string; readonly details?: readonly string[] } = {}
): Promise<void> {
  await renderStatic(cliErrorView(error, options))
}

/** The screen `renderCliError` prints, for a live view that ends with it. */
export function cliErrorView(
  error: unknown,
  options: { readonly title?: string; readonly details?: readonly string[] } = {}
): string {
  const remediation = errorRemediation(error)
  return errorView({
    ...(options.title ? { title: options.title } : {}),
    message: errorMessage(error),
    ...(remediation ? { remediation } : {}),
    ...(options.details ? { details: options.details } : {}),
  })
}

export async function renderVersion(version: string): Promise<void> {
  await renderStatic(versionView(version))
}

/** Root or command help, after the usage error that led to it when there is one. */
export async function renderHelp(help: CliHelp, usageError?: string): Promise<void> {
  await renderStatic(
    help.path.length === 0
      ? helpView({ errorMessage: usageError })
      : commandHelpView({ help, errorMessage: usageError })
  )
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface Task {
  /** Says what the work is doing now. */
  step(label: string): void
  /** Clears the spinner. What was printed while it spun stays. */
  stop(): void
}

/**
 * A one-line spinner for work that takes a moment: `⠋ sixb check · Loading runtime`. Only a
 * terminal sees it; a pipe or a CI log gets nothing, and the result screen that follows says what
 * happened. Lines the work prints meanwhile land above the spinner, not inside it.
 */
export function startTask(command: string, label: string): Task {
  if (!process.stdout.isTTY || process.env.CI) return { step() {}, stop() {} }

  let frame = 0
  let current = label
  let drawn = false
  const line = () =>
    `  ${tone.blue(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? glyph.mark)} ${tone.strong(`sixb ${command}`)} ${tone.muted(`${glyph.dot} ${current}`)}`
  const write = process.stdout.write.bind(process.stdout)
  const clear = () => {
    if (drawn) write("\r\x1b[2K")
    drawn = false
  }
  const draw = () => {
    write(`\r\x1b[2K${line()}`)
    drawn = true
  }

  // Output written while the spinner shows goes above it.
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const
  const originals = consoleMethods.map((method) => console[method])
  consoleMethods.forEach((method, index) => {
    const original = originals[index] as (...args: unknown[]) => void
    console[method] = (...args: unknown[]) => {
      clear()
      original.apply(console, args)
      draw()
    }
  })
  const stderrWrite = process.stderr.write.bind(process.stderr)
  const wrapWrite =
    (target: typeof write) =>
    (...args: Parameters<typeof write>): boolean => {
      clear()
      const result = target(...args)
      draw()
      return result
    }
  process.stdout.write = wrapWrite(write) as typeof process.stdout.write
  process.stderr.write = wrapWrite(stderrWrite) as typeof process.stderr.write

  write("\x1b[?25l")
  const restoreCursor = () => write("\x1b[?25h")
  process.once("exit", restoreCursor)
  draw()
  const timer = setInterval(() => {
    frame += 1
    draw()
  }, 80)

  let stopped = false
  return {
    step(next) {
      current = next
      if (!stopped) draw()
    },
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      clear()
      process.stdout.write = write as typeof process.stdout.write
      process.stderr.write = stderrWrite as typeof process.stderr.write
      consoleMethods.forEach((method, index) => {
        console[method] = originals[index] as (typeof console)[typeof method]
      })
      restoreCursor()
      process.off("exit", restoreCursor)
    },
  }
}

/** Runs work behind a spinner, and clears it whether the work succeeds or throws. */
export async function withTask<T>(
  command: string,
  label: string,
  work: (task: Task) => Promise<T>
): Promise<T> {
  const task = startTask(command, label)
  try {
    return await work(task)
  } finally {
    task.stop()
  }
}

/** The line a long-running role prints as it begins to shut down. */
export function printStopping(command: string): void {
  process.stdout.write(`\n  ${tone.faint(glyph.idle)} ${tone.muted(`Stopping sixb ${command}…`)}\n`)
}
