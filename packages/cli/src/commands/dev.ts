import { dirname, resolve } from "node:path"
import { runDevSupervisor } from "../lib/dev-supervisor"
import type { DevOptions } from "./dev-runner"
import { assertDevEnv } from "./env"

export type { DevOptions } from "./dev-runner"

export async function runDev(options: DevOptions = {}) {
  // The project's configuration can tell a branch runtime from a laptop by it, as the template does
  // to keep a branch's storage inside its sandbox.
  if (options.branch !== undefined) process.env.SIXB_BRANCH = options.branch
  if (process.env.SIXB_DEV_CHILD === "1" && process.send) {
    // The parent cannot enforce its deadline after it dies. Arm our own before
    // importing the runner so a stuck import/startup also has a shutdown bound.
    let deadline: ReturnType<typeof setTimeout> | undefined
    const forceExit = () => {
      if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL")
      else process.exit(1)
    }
    const disconnected = () => {
      deadline ??= setTimeout(forceExit, 10_000)
      process.kill(process.pid, "SIGTERM")
    }
    process.once("disconnect", disconnected)
    try {
      const { runDevRuntime } = await import("./dev-runner")
      await runDevRuntime(options)
    } finally {
      process.off("disconnect", disconnected)
      clearTimeout(deadline)
      // Graceful cleanup can finish while unowned compiler/sandbox descendants
      // remain. With no parent, this process must reap its isolated group itself.
      if (!process.connected) forceExit()
    }
    process.exit(process.exitCode ?? 0)
  }
  await assertDevEnv(dirname(resolve(options.entry ?? "sixb.config.ts")), {
    pullWithoutAsking: options.branch !== undefined,
  })
  await runDevSupervisor(options)
}
