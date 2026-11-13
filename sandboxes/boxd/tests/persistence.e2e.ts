import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { SandboxError, SandboxStateUnavailableError } from "@sixb/core/sandboxes"
import { LIVE_TIMEOUT_MS, liveEnabled, liveFactory } from "./live"

// Run with: SIXB_BOXD_E2E=1 bun test --timeout 300000 ./sandboxes/boxd/tests/persistence.e2e.ts
test.skipIf(!liveEnabled)(
  "a named sandbox keeps its files and processes across stop and resume",
  async () => {
    const factory = liveFactory({ setup: ["echo setup >> setup.log"] })
    const name = `sixb-sb-e2e-${randomUUID()}`
    const created = await factory.create({ persistence: { name } })
    let current = created
    try {
      await created.writeFiles([{ path: "notes.txt", contents: "kept" }])
      const started = await created.runCommand("sh", [
        "-c",
        "setsid sh -c 'echo $$ > worker.pid; exec sleep 600' </dev/null >/dev/null 2>&1 &",
      ])
      expect(started.exitCode).toBe(0)

      // A second create under the same name never attaches to it.
      const duplicate = await factory
        .create({ persistence: { name } })
        .catch((error: unknown) => error)
      expect(duplicate).toBeInstanceOf(SandboxError)

      // A running sandbox is not resumed by a second execution.
      const running = await factory.resume(name).catch((error: unknown) => error)
      expect(running).toBeInstanceOf(SandboxError)
      expect(running).not.toBeInstanceOf(SandboxStateUnavailableError)

      const stopStart = Date.now()
      await created.stop()
      console.log(`[BoxdE2E] stop (hibernate) took ${Date.now() - stopStart} ms`)

      const resumeStart = Date.now()
      current = await factory.resume(name, { network: { mode: "none" } })
      console.log(`[BoxdE2E] resume (wake) took ${Date.now() - resumeStart} ms`)
      expect(current.id).toBe(created.id)

      const notes = await current.runCommand("cat", ["notes.txt"])
      expect(notes.stdout).toBe("kept")
      // Setup ran once, at creation.
      expect((await current.runCommand("cat", ["setup.log"])).stdout).toBe("setup\n")
      // Hibernation keeps memory: the process started before stop is still there.
      const alive = await current.runCommand("sh", ["-c", 'kill -0 "$(cat worker.pid)"'])
      expect(alive.exitCode).toBe(0)
    } finally {
      await current.destroy()
    }

    const gone = await factory.resume(name).catch((error: unknown) => error)
    expect(gone).toBeInstanceOf(SandboxStateUnavailableError)
  },
  LIVE_TIMEOUT_MS
)

test.skipIf(!liveEnabled)(
  "resuming a name that was never created reports missing state",
  async () => {
    const error = await liveFactory()
      .resume(`sixb-sb-e2e-missing-${randomUUID()}`)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SandboxStateUnavailableError)
  },
  LIVE_TIMEOUT_MS
)
