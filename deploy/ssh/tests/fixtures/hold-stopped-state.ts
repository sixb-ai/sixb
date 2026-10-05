import { mock } from "bun:test"
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as state from "../../src/server/state"

const persistState = state.writeProcessState
let held = false

// Preloaded only in the child supervisor: hold the final state before its atomic rename while
// allowing the real child exit and control response to proceed normally.
mock.module("../../src/server/state", () => ({
  ...state,
  async writeProcessState(path: string, value: state.ProcessState): Promise<void> {
    if (
      !held &&
      value.instances.some((entry) => entry.service === "api" && entry.status === "stopped")
    ) {
      held = true
      const directory = dirname(path)
      await writeFile(join(directory, "state-write-held"), "")
      const release = join(directory, "release-state-write")
      const deadline = Date.now() + 5_000
      while (!(await Bun.file(release).exists())) {
        if (Date.now() >= deadline) throw new Error("Timed out releasing the held state write.")
        await Bun.sleep(10)
      }
    }
    await persistState(path, value)
  },
}))
