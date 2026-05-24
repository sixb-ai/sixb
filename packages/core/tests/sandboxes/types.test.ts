import { describe, expect, test } from "bun:test"
import {
  SandboxError,
  SandboxIsolationUnavailableError,
  SandboxNotRunningError,
  SandboxTimeoutError,
} from "../../src/sandboxes"

describe("sandbox error hierarchy", () => {
  test("each subclass extends SandboxError with a distinct name", () => {
    const notRunning = new SandboxNotRunningError("stopped")
    const timedOut = new SandboxTimeoutError("too slow")
    const unavailable = new SandboxIsolationUnavailableError("bwrap missing")

    expect(notRunning).toBeInstanceOf(SandboxError)
    expect(timedOut).toBeInstanceOf(SandboxError)
    expect(unavailable).toBeInstanceOf(SandboxError)

    expect(notRunning.name).toBe("SandboxNotRunningError")
    expect(timedOut.name).toBe("SandboxTimeoutError")
    expect(unavailable.name).toBe("SandboxIsolationUnavailableError")

    expect(notRunning.message).toBe("stopped")
  })

  test("base SandboxError extends Error", () => {
    const err = new SandboxError("boom")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("SandboxError")
  })
})
