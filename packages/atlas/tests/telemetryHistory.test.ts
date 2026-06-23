import { describe, expect, test } from "bun:test"
import { getHistoryBounds, isSampleInBounds } from "../src/lib/telemetryHistory"

describe("telemetry history bounds", () => {
  test("keeps live samples inside a custom range", () => {
    const bounds = getHistoryBounds({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T23:59:59.999Z",
    })

    expect(isSampleInBounds({ timestamp: "2026-01-01T12:00:00.000Z" }, bounds)).toBe(true)
    expect(isSampleInBounds({ timestamp: "2026-01-02T00:00:00.000Z" }, bounds)).toBe(false)
  })

  test("keeps live samples inside a relative range", () => {
    const nowMs = new Date("2026-01-01T12:00:00.000Z").getTime()
    const bounds = getHistoryBounds({ range: "5m" }, nowMs)

    expect(isSampleInBounds({ timestamp: "2026-01-01T11:56:00.000Z" }, bounds)).toBe(true)
    expect(isSampleInBounds({ timestamp: "2026-01-01T11:54:59.999Z" }, bounds)).toBe(false)
    expect(isSampleInBounds({ timestamp: "2026-01-01T12:00:00.001Z" }, bounds)).toBe(false)
  })
})
