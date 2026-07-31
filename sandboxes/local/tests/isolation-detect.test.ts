import { describe, expect, test } from "bun:test"
import { detectIsolation, warnIfUnisolated } from "../src/isolation/detect"

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

describe("warnIfUnisolated", () => {
  test("says commands run unisolated, and why", () => {
    // `resolveBackend` in `auto` mode returned `probe.backend` and dropped
    // `probe.message` on the floor, so a host with no backend ran every agent command
    // directly and looked exactly like a host that was isolating them.
    const probe = detectIsolation({ platform: "darwin", hasBinary: () => false })
    const warnings = captureWarnings(() => warnIfUnisolated(probe))

    expect(probe.backend).toBe("none")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("commands run unisolated on the host")
    // The probe's own words, which name the actual reason for this platform.
    expect(warnings[0]).toContain("sandbox-exec not on PATH")
  })

  test("stays quiet when a backend was found", () => {
    const probe = detectIsolation({
      platform: "linux",
      hasBinary: (name) => name === "bwrap",
    })

    expect(captureWarnings(() => warnIfUnisolated(probe))).toEqual([])
  })
})

/** Captures `console.warn` for the duration of one call. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}
