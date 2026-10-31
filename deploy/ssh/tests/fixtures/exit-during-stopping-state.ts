import { mock } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as state from "../../src/server/state"

const persistState = state.writeProcessState
let held = false

// Preloaded only in the child supervisor: while the "stopping" state is being written, the api
// exits on its own, the way it does when systemd signals the whole unit. The write finishes only
// once the supervisor has logged that exit.
mock.module("../../src/server/state", () => ({
  ...state,
  async writeProcessState(path: string, value: state.ProcessState): Promise<void> {
    const api = value.instances.find((entry) => entry.service === "api")
    if (!held && api?.status === "stopping" && api.pid) {
      held = true
      process.kill(api.pid, "SIGTERM")
      const log = join(dirname(path), "logs", "northline-api-0.log")
      const deadline = Date.now() + 5_000
      while (!(await readFile(log, "utf8")).includes("exit code=")) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the api to exit.")
        await Bun.sleep(10)
      }
    }
    await persistState(path, value)
  },
}))
