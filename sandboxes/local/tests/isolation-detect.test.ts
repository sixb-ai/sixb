import { describe, expect, test } from "bun:test"
import { detectIsolation } from "../src/isolation/detect"

describe("detectIsolation", () => {
  test("darwin with sandbox-exec available picks seatbelt", () => {
    const probe = detectIsolation({
      platform: "darwin",
      hasBinary: (name) => name === "sandbox-exec",
    })
    expect(probe.backend).toBe("seatbelt")
    expect(probe.available).toBe(true)
  })

  test("darwin with unusable sandbox-exec falls back to none", () => {
    const probe = detectIsolation({
      platform: "darwin",
      hasBinary: (name) => name === "sandbox-exec",
      canRunSeatbelt: () => false,
    })
    expect(probe.backend).toBe("none")
    expect(probe.available).toBe(true)
    expect(probe.message).toContain("cannot apply")
  })

  test("darwin without sandbox-exec falls back to none", () => {
    const probe = detectIsolation({ platform: "darwin", hasBinary: () => false })
    expect(probe.backend).toBe("none")
    expect(probe.available).toBe(true)
    expect(probe.message).toContain("sandbox-exec")
  })

  test("linux with bwrap available picks bwrap", () => {
    const probe = detectIsolation({
      platform: "linux",
      hasBinary: (name) => name === "bwrap",
    })
    expect(probe.backend).toBe("bwrap")
    expect(probe.available).toBe(true)
  })

  test("linux without bwrap falls back to none", () => {
    const probe = detectIsolation({ platform: "linux", hasBinary: () => false })
    expect(probe.backend).toBe("none")
    expect(probe.message).toContain("bwrap")
  })

  test("unsupported platform falls back to none", () => {
    const probe = detectIsolation({ platform: "win32", hasBinary: () => true })
    expect(probe.backend).toBe("none")
    expect(probe.message).toContain("win32")
  })
})
