import { afterEach, describe, expect, test } from "bun:test"
import {
  resolveDrainTimeoutMs,
  runUntilSignal,
  type ShutdownSignal,
} from "../src/lib/role-lifecycle"

const originalDrainTimeout = process.env.SIXB_DRAIN_TIMEOUT_MS

afterEach(() => {
  if (originalDrainTimeout === undefined) delete process.env.SIXB_DRAIN_TIMEOUT_MS
  else process.env.SIXB_DRAIN_TIMEOUT_MS = originalDrainTimeout
})

describe("role-lifecycle", () => {
  test("passes the received signal to onShutdown and escalates SIGINT during a drain", async () => {
    const received: ShutdownSignal[] = []
    let interrupted = false
    const release = Promise.withResolvers<void>()

    const running = runUntilSignal(
      async (signal) => {
        received.push(signal)
        await release.promise
      },
      {
        onInterrupt: () => {
          interrupted = true
          release.resolve()
        },
      }
    )

    process.emit("SIGTERM", "SIGTERM")
    await Promise.resolve()
    expect(received).toEqual(["SIGTERM"])
    expect(interrupted).toBe(false)

    process.emit("SIGINT", "SIGINT")
    await running
    expect(interrupted).toBe(true)
  })

  test("resolves SIXB_DRAIN_TIMEOUT_MS and rejects invalid values", () => {
    delete process.env.SIXB_DRAIN_TIMEOUT_MS
    expect(resolveDrainTimeoutMs(60_000)).toBe(60_000)

    process.env.SIXB_DRAIN_TIMEOUT_MS = "15000"
    expect(resolveDrainTimeoutMs(60_000)).toBe(15_000)

    process.env.SIXB_DRAIN_TIMEOUT_MS = "0"
    expect(resolveDrainTimeoutMs(60_000)).toBe(0)

    for (const invalid of ["-1", "1.5", "abc"]) {
      process.env.SIXB_DRAIN_TIMEOUT_MS = invalid
      expect(() => resolveDrainTimeoutMs(60_000)).toThrow("SIXB_DRAIN_TIMEOUT_MS")
    }
  })
})
