import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import type { DevOptions } from "../commands/dev-runner"
import { watchDevSource } from "./dev-watch"

/** The parent never imports project modules: every generation gets a fresh module graph. */
export async function runDevSupervisor(options: DevOptions): Promise<void> {
  const root = dirname(resolve(options.entry ?? "sixb.config.ts"))
  let child: { process: ReturnType<typeof spawn>; exited: Promise<number | null> } | null = null
  let stopping = false
  let restarting = false
  let pending = false
  let hasCustomApp = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let complete!: () => void
  const finished = new Promise<void>((resolve) => {
    complete = resolve
  })
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
      console.error("[SixbDev] Shutdown timed out; terminating the dev process.")
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
        hasCustomApp = false
        if (started) await watcher.refresh()
        else await watcher.ready
        if (stopping) break
        started = true
        // All saves before this spawn are already in its fresh module graph.
        pending = false
        clearTimeout(timer)
        const proc = spawn(process.execPath, process.argv.slice(1), {
          env: {
            ...process.env,
            SIXB_DEV_CHILD: "1",
            SIXB_DEV_GENERATION: crypto.randomUUID(),
            SIXB_DEV_READY: "",
          },
          detached: process.platform !== "win32",
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        })
        const current = {
          process: proc,
          exited: new Promise<number | null>((resolve, reject) => {
            proc.once("exit", resolve)
            proc.once("error", reject)
          }),
        }
        proc.on("message", (message: unknown) => {
          if (child !== current || !message || typeof message !== "object") return
          if ("type" in message && message.type === "ready") {
            clearTimeout(startupTimer)
            hasCustomApp = "hasCustomApp" in message && message.hasCustomApp === true
            console.log(`[SixbDev] Ready (pid ${proc.pid}). Watching ${root}`)
          } else if ("type" in message && message.type === "startup-error") {
            hasCustomApp = false
          }
        })
        child = current
        startupTimer = setTimeout(() => {
          if (child === current) {
            console.error("[SixbDev] Startup timed out. Edit a source file to retry.")
            terminate(current, "SIGKILL")
          }
        }, 60_000)
        void current.exited
          .then((code) => {
            terminate(current, "SIGKILL")
            if (child !== current) return
            clearTimeout(startupTimer)
            child = null
            hasCustomApp = false
            if (!stopping && !restarting) {
              console.error(`[SixbDev] Dev process exited (${code}). Waiting for source changes.`)
            }
          })
          .catch(fail)
      }
    } finally {
      restarting = false
    }
  }

  const watcher = watchDevSource(
    root,
    () => hasCustomApp,
    (filename) => {
      if (stopping) return
      pending = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        console.log(`[SixbDev] Source changed${filename ? `: ${filename}` : ""}. Restarting…`)
        void restart().catch(fail)
      }, 150)
    },
    fail
  )

  async function shutdown() {
    if (stopping) return
    stopping = true
    clearTimeout(timer)
    try {
      await watcher.close()
      await stopChild()
    } finally {
      complete()
    }
  }

  function fail(error: unknown) {
    console.error("[SixbDev]", error)
    process.exitCode = 1
    void shutdown().catch((shutdownError) =>
      console.error("[SixbDev] Shutdown failed:", shutdownError)
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
  }
}
