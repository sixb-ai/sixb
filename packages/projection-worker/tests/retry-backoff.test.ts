import { describe, expect, test } from "bun:test"
import { projectionRetryAvailableAt } from "../src/retry-backoff"

const NOW = Date.parse("2026-01-01T00:00:00.000Z")

describe("projection retry backoff", () => {
  test("grows exponentially and caps the delay without capping attempts", () => {
    const delay = (attempt: number) =>
      Date.parse(projectionRetryAvailableAt({ jobId: "projection-1", attempt, now: NOW })) - NOW

    expect(delay(1)).toBeGreaterThanOrEqual(500)
    expect(delay(2)).toBeGreaterThanOrEqual(1_000)
    expect(delay(8)).toBeGreaterThanOrEqual(64_000)
    expect(delay(100_000)).toBeLessThanOrEqual(5 * 60_000)
  })

  test("uses stable per-job jitter", () => {
    const first = projectionRetryAvailableAt({ jobId: "projection-1", attempt: 4, now: NOW })
    expect(projectionRetryAvailableAt({ jobId: "projection-1", attempt: 4, now: NOW })).toBe(first)
    expect(projectionRetryAvailableAt({ jobId: "projection-2", attempt: 4, now: NOW })).not.toBe(
      first
    )
  })
})
