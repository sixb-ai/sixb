import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import type { DevOptions } from "../commands/dev-runner"
import { canRunLive } from "../ui/live/can-run-live"
import { loadDesktop } from "./desktop"
import { DEV_UI_ENV, type DevChildMessage } from "./dev-messages"
import { watchDevSource } from "./dev-watch"
import { errorMessage } from "./errors"

/**
 * Where the supervisor's news goes. A terminal gets the live footer (`ui/live/dev.tsx`), which
 * draws the dev process's output itself; anything else gets the `[SixbDev]` lines, and the dev
 * process prints its own screens.
 */
export interface DevReporter {
  /** `pipe` when the reporter writes the dev process's output; `inherit` lets it print. */
  readonly output: "inherit" | "pipe"
  /** A line the dev process wrote, when `output` is `pipe`. */
  line(text: string): void
  message(message: DevChildMessage, pid: number | undefined): void
  restarting(filename: string | undefined): void
  exited(code: number | null): void
  timedOut(): void
  error(text: string): void
  stopping(): void
  stop(): Promise<void>
}

export interface DevControls {
  /** Restarts the dev process now, as a source change would. */
  restart(): void
  /** Stops `sixb dev`, as ctrl+c would. */
  quit(): void
}

/** The lines `sixb dev` prints where no live footer can be drawn. */
export function plainDevReporter(root: string): DevReporter {
  return {
    output: "inherit",
    line(text) {
      console.log(text)
    },
    message(message, pid) {
      if (message.type === "ready") console.log(`[SixbDev] Ready (pid ${pid}). Watching ${root}`)
    },
    restarting(filename) {
      console.log(`[SixbDev] Source changed${filename ? `: ${filename}` : ""}. Restarting…`)
    },
    exited(code) {
      console.error(`[SixbDev] Dev process exited (${code}). Waiting for source changes.`)
    },
    timedOut() {
      console.error("[SixbDev] Startup timed out. Edit a source file to retry.")
    },
    error(text) {
      console.error(`[SixbDev] ${text}`)
    },
    stopping() {},
    async stop() {},
  }
}

/** The parent never imports project modules: every generation gets a fresh module graph. */
export async function runDevSupervisor(options: DevOptions): Promise<void> {
  const root = dirname(resolve(options.entry ?? "sixb.config.ts"))
  // Loaded first, so a project without the package hears so before the dev server starts.
  const desktop = options.desktop ? await loadDesktop(root) : null
  // Opened once the app is first served, and kept open across restarts: the app reloads itself.
  let desktopWindow: Promise<{ close(): void } | null> | null = null
  let child: { process: ReturnType<typeof spawn>; exited: Promise<number | null> } | null = null
  let stopping = false
  let restarting = false
  let pending = false
  // While the dev process runs and watches `app/`, its app server reloads app sources itself.
  let appWatched = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let complete!: () => void
  const finished = new Promise<void>((resolve) => {
    complete = resolve
  })
  const controls: DevControls = {
    restart() {
      if (stopping) return
      reporter.restarting(undefined)
      pending = true
      clearTimeout(timer)
      void restart().catch(fail)
    },
    quit() {
      requestShutdown()
    },
  }
  const reporter: DevReporter = canRunLive()
    ? await (await import("../ui/live/dev")).startDevFooter({ root, controls })
    : plainDevReporter(root)
  function terminate(current: NonNullable<typeof child>, signal: NodeJS.Signals) {
    try {
      if (process.platform !== "win32" && current.process.pid) {
        process.kill(-current.process.pid, signal)
      } else {
        current.process.kill(signal)
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
        throw error
      }
    }
  }

  async function stopChild() {
    clearTimeout(startupTimer)
    const current = child
    if (!current) return
    // Give the runtime ownership of graceful shutdown. Kill the isolated process group
    // only on the deadline (or after exit) to reap any compiler/sandbox descendants too.
    current.process.kill("SIGTERM")
    const deadline = setTimeout(() => {
      reporter.error("Shutdown timed out; terminating the dev process.")
      terminate(current, "SIGKILL")
    }, 10_000)
    try {
      await current.exited
    } finally {
      clearTimeout(deadline)
      if (child === current) child = null
    }
  }

  async function restart() {
    if (stopping || restarting) return
    restarting = true
    try {
      while (pending && !stopping) {
        await stopChild()
        if (stopping) break
        appWatched = false
        if (started) await watcher.refresh()
        else await watcher.ready
        if (stopping) break
        started = true
        // All saves before this spawn are already in its fresh module graph.
        pending = false
        clearTimeout(timer)
        const proc = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
          env: {
            ...process.env,
            SIXB_DEV_CHILD: "1",
            SIXB_DEV_GENERATION: crypto.randomUUID(),
            SIXB_DEV_READY: "",
            [DEV_UI_ENV]: reporter.output === "pipe" ? "footer" : "",
          },
          detached: process.platform !== "win32",
          stdio: ["ignore", reporter.output, reporter.output, "ipc"],
        })
        if (reporter.output === "pipe") {
          forwardLines(proc.stdout, reporter)
          forwardLines(proc.stderr, reporter)
        }
        const current = {
          process: proc,
          exited: new Promise<number | null>((resolve, reject) => {
            proc.once("exit", resolve)
            proc.once("error", reject)
          }),
        }
        proc.on("message", (message: unknown) => {
          if (child !== current || !message || typeof message !== "object") return
          if (!("type" in message)) return
          reporter.message(message as DevChildMessage, proc.pid)
          if (message.type === "ready") {
            clearTimeout(startupTimer)
            appWatched = "watchesApp" in message && message.watchesApp === true
            const app = servedApp(message)
            if (desktop && app && !desktopWindow) {
              desktopWindow = desktop
                .openDesktopApp({ projectRoot: root, appUrl: app.url, apiOrigin: app.apiOrigin })
                .catch((error: unknown) => {
                  reporter.error(`Could not open the desktop window: ${errorMessage(error)}`)
                  // The next generation to come up tries again.
                  desktopWindow = null
                  return null
                })
            }
          } else if (message.type === "startup-error") {
            appWatched = false
          }
        })
        child = current
        startupTimer = setTimeout(() => {
          if (child === current) {
            reporter.timedOut()
            terminate(current, "SIGKILL")
          }
        }, 60_000)
        void current.exited
          .then((code) => {
            terminate(current, "SIGKILL")
            if (child !== current) return
            clearTimeout(startupTimer)
            child = null
            appWatched = false
            if (!stopping && !restarting) reporter.exited(code)
          })
          .catch(fail)
      }
    } finally {
      restarting = false
    }
  }

  const watcher = watchDevSource(
    root,
    () => appWatched,
    (filename) => {
      if (stopping) return
      pending = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        reporter.restarting(filename)
        void restart().catch(fail)
      }, 150)
    },
    fail
  )

  async function shutdown() {
    if (stopping) return
    stopping = true
    clearTimeout(timer)
    reporter.stopping()
    try {
      // First, or the window says the app is unreachable as the server stops. Not awaited: a window
      // still being set up closes once it opens, and does not hold up the rest of the shutdown.
      void desktopWindow?.then((opened) => opened?.close())
      await watcher.close()
      await stopChild()
    } finally {
      complete()
    }
  }

  function fail(error: unknown) {
    reporter.error(errorMessage(error))
    process.exitCode = 1
    void shutdown().catch((shutdownError) =>
      reporter.error(`Shutdown failed: ${errorMessage(shutdownError)}`)
    )
  }

  const requestShutdown = () => {
    void shutdown().catch(fail)
  }
  process.on("SIGINT", requestShutdown)
  process.on("SIGTERM", requestShutdown)
  try {
    pending = true
    await restart()
    await finished
  } finally {
    process.off("SIGINT", requestShutdown)
    process.off("SIGTERM", requestShutdown)
    await shutdown()
    await reporter.stop()
  }
}

/** Hands the reporter each whole line a stream writes. */
function forwardLines(stream: NodeJS.ReadableStream | null, reporter: DevReporter): void {
  if (!stream) return
  let buffered = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) reporter.line(line.replace(/\r$/, ""))
  })
  stream.on("end", () => {
    if (buffered) reporter.line(buffered)
    buffered = ""
  })
}

/** Where the dev process serves the app, from its ready message; `null` when it serves none. */
function servedApp(message: object): { readonly url: string; readonly apiOrigin: string } | null {
  if (!("app" in message) || typeof message.app !== "object" || message.app === null) return null
  const { url, apiOrigin } = message.app as { readonly url?: unknown; readonly apiOrigin?: unknown }
  return typeof url === "string" && typeof apiOrigin === "string" ? { url, apiOrigin } : null
}
