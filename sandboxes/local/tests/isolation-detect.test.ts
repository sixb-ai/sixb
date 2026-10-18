import { describe, expect, test } from "bun:test"
import { type DetectInput, detectIsolation, warnIfUnisolated } from "../src/isolation/detect"

describe("detectIsolation", () => {
  // Every fallback stays available as "none" and names the reason in its message.
  test.each([
    [
      "darwin with sandbox-exec available picks seatbelt",
      { platform: "darwin", hasBinary: (name: string) => name === "sandbox-exec" },
      "seatbelt",
      "sandbox-exec available",
    ],
    [
      "darwin with unusable sandbox-exec falls back to none",
      {
        platform: "darwin",
        hasBinary: (name: string) => name === "sandbox-exec",
        canRunSeatbelt: () => false,
      },
      "none",
      "cannot apply",
    ],
    [
      "linux with bwrap available picks bwrap",
      { platform: "linux", hasBinary: (name: string) => name === "bwrap" },
      "bwrap",
      "bwrap available",
    ],
    [
      "linux without bwrap falls back to none",
      { platform: "linux", hasBinary: () => false },
      "none",
      "bwrap not on PATH",
    ],
    [
      "unsupported platform falls back to none",
      { platform: "win32", hasBinary: () => true },
      "none",
      "win32",
    ],
  ] as const)("%s", (_label, input: DetectInput, backend, message) => {
    const probe = detectIsolation(input)
    expect(probe.backend).toBe(backend)
    expect(probe.available).toBe(true)
    expect(probe.message).toContain(message)
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
